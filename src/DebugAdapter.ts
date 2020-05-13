import { DebugSession, OutputEvent, TerminatedEvent, Source, Scope, Handles, Variable, StoppedEvent, InitializedEvent, BreakpointEvent, Breakpoint, ContinuedEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { GDB } from './gdb/gdb';
import * as IGDB from './gdb/IGDB';
import { ResourceManager } from './ResourceManager';
import { File } from '../lib/node-utility/File';
import { Writable } from 'stream';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as vscode from 'vscode';

class Subject {

    private _event: EventEmitter;

    constructor() {
        this._event = new EventEmitter();
    }

    notify() {
        this._event.emit('done');
    }

    async wait(): Promise<void> {
        return new Promise((resolve) => {
            this._event.once('done', () => {
                resolve();
            });
        });
    }
}

export interface LaunchArguments extends DebugProtocol.LaunchRequestArguments, IGDB.ConnectOption {
    runToMain?: boolean;
}

enum ScopeType {
    SCOPE_GLOBAL = 1, // ID must > 0
    SCOPE_LOCAL,
    SCOPE_FUNC_PARAMS,
    SCOPE_REGISTER
}

export class DebugAdapter extends DebugSession {

    // must bigger than Scope ID
    private static readonly HANLER_START: number = 10;
    private static readonly HANLER_NULL: number = -1;

    private readonly ThreadID = 1;

    private gdb: GDB;
    private cwd: File;

    private configDoneEmitter: Subject = new Subject();
    private isConnected: boolean = false;
    private stringAsArray: boolean;

    private globalVars: string[] = [];
    private vHandles: Handles<Variable[]>;
    private rootVariables: Map<ScopeType, Variable[]> = new Map();

    private frameChanged = false;
    private funcArguments: IGDB.Variable[] = [];

    private bpMap: Map<string, IGDB.Breakpoint[]> = new Map();
    private preLoadBPMap: Map<string, IGDB.Breakpoint[]> = new Map();

    constructor() {
        super();

        this.vHandles = new Handles(DebugAdapter.HANLER_START);
        this.cwd = <File>ResourceManager.getInstance().getWorkspaceDir();
        this.gdb = new GDB(ResourceManager.getInstance().isVerboseMode());
        this.stringAsArray = ResourceManager.getInstance().parseString2Array();

        this.setDebuggerColumnsStartAt1(false);
        this.setDebuggerLinesStartAt1(false);

        this.gdb.on('log', (logData) => {
            switch (logData.type) {
                case 'warning':
                    this.warn(logData.msg);
                    break;
                case 'error':
                    this.error(logData.msg);
                    break;
                default:
                    this.log(logData.msg);
                    break;
            }
        });
    }

    private log(line: string) {
        this.sendEvent(new OutputEvent(`${line}\r\n`, 'stdout'));
    }

    private warn(line: string) {
        this.sendEvent(new OutputEvent(`${line}\r\n`));
    }

    private error(line: string) {
        this.sendEvent(new OutputEvent(`${line}\r\n`, 'stderr'));
    }

    //---

    private cacheChild(children: IGDB.VariableChildren): number {

        return this.vHandles.create(children.map((item) => {
            const vTemp = new Variable(item.name, '', DebugAdapter.HANLER_NULL);
            switch (item.type) {
                case 'array':
                    vTemp.value = `array [${(<any[]>item.value).length}]`;
                    vTemp.variablesReference = this.cacheChild(<IGDB.VariableChildren>item.value);
                    break;
                case 'obj':
                    vTemp.value = 'struct {...}';
                    vTemp.variablesReference = this.cacheChild(<IGDB.VariableChildren>item.value);
                    break;
                default:
                    vTemp.value = <string>item.value;
                    break;
            }
            return vTemp;
        }));
    }

    private vClearAll() {
        this.vHandles.reset();
    }

    private vToVariable(_var: IGDB.Variable): Variable {

        const result: DebugProtocol.Variable = new Variable(_var.name, '', DebugAdapter.HANLER_NULL);

        switch (_var.type) {
            case 'array':
                result.value = `array [${(<any[]>_var.value).length}]`;
                result.variablesReference = this.cacheChild(<IGDB.VariableChildren>_var.value);
                break;
            case 'obj':
                result.value = 'struct {...}';
                result.variablesReference = this.cacheChild(<IGDB.VariableChildren>_var.value);
                break;
            case 'string':
                {
                    const value: string = <string>_var.value;

                    result.value = `"${value}"`;
                    result.type = _var.type;

                    // conver a string to an array
                    if (this.stringAsArray) {
                        const cArr = Array.from(value).map((_char, index) => {
                            return <IGDB.Variable>{
                                name: index.toString(),
                                type: 'integer',
                                value: _char.charCodeAt(0).toString()
                            };
                        });
                        // add '\0' suffix
                        cArr.push({
                            name: cArr.length.toString(),
                            type: 'integer',
                            value: '0'
                        });
                        result.variablesReference = this.cacheChild(cArr);
                    }
                }
                break;
            default:
                result.value = <string>_var.value;
                result.type = _var.type;
                break;
        }

        return result;
    }

    private vGetChildren(ref: number): Variable[] {
        return this.vHandles.get(ref) || [];
    }

    private vGetRoot(name: string): Variable | undefined {

        for (const rootList of this.rootVariables.values()) {
            const index = rootList.findIndex((v) => { return v.name === name; });
            if (index !== -1) {
                return rootList[index];
            }
        }

        return undefined;
    }

    //---

    private createSource(_path: string): Source {
        if (path.isAbsolute(_path)) {
            return new Source(path.basename(_path), File.ToUri(_path));
        } else {
            const absPath = path.join(this.cwd.path, _path);
            return new Source(path.basename(absPath), File.ToUri(absPath));
        }
    }

    private toRelative(_path: string): string {
        return _path;
    }

    private async loadBreakPoints() {

        for (const fPath of this.preLoadBPMap.keys()) {

            const bpList = <IGDB.Breakpoint[]>this.preLoadBPMap.get(fPath);
            const validList: IGDB.Breakpoint[] = [];

            for (const bp of bpList) {
                const bkpt = await this.gdb.addBreakPoint(bp);
                if (bkpt) {
                    validList.push(bkpt);
                    this.sendEvent(new BreakpointEvent('changed', new Breakpoint(
                        true, bkpt.line, 0, (bkpt.file ? this.createSource(bkpt.file) : undefined)
                    )));
                }
            }

            this.bpMap.set(fPath, validList);
        }

        this.preLoadBPMap.clear();
    }

    /**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
    protected async initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {

        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsRestartRequest = true;
        response.body.supportsTerminateRequest = true;

        const resManager = ResourceManager.getInstance();
        const gdbPath = resManager
            .getBinDir().path + File.sep + 'gdb.exe';

        // clear log
        const logFile = File.fromArray([resManager.getBinDir().dir, 'swim', 'Error.log']);
        if (logFile.IsFile()) {
            logFile.Write('');
        }

        const errMsg = await this.gdb.start(gdbPath, [
            `--quiet`,
            `--cd=${this.cwd.path}`,
            `--directory=${this.cwd.path}`
        ]);

        if (errMsg) {
            this.error(errMsg);
            this.sendEvent(new TerminatedEvent());
        } else {
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        }
    }

    // terminal gdb connect
    protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request) {
        await this.gdb.disconnect();
        this.isConnected = false;
        this.sendResponse(response);
    }

    // kill gdb.exe
    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments) {
        this.warn('[SEND]: kill gdb.exe');
        await this.gdb.kill();
        this.warn('\tdone');
        this.warn('[END]');
        this.sendResponse(response);
    }

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {

        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        setTimeout(() => {
            this.configDoneEmitter.notify();
        }, 500);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArguments) {

        // wait until configuration has finished (and configurationDoneRequest has been called)
        await this.configDoneEmitter.wait();

        let extraCommand: string[] | undefined;

        if (args.runToMain !== false) {
            extraCommand = [
                `break main`
            ];
        }

        // start the program in the runtime
        this.isConnected = await this.gdb.connect(args, extraCommand);

        if (this.isConnected) {
            this.sendResponse(response);
            await this.loadBreakPoints();
            this.gdb.continue().then(() => {
                if (args.runToMain !== false) {
                    this.sendEvent(new StoppedEvent('entry', this.ThreadID));
                } else {
                    this.sendEvent(new StoppedEvent('breakpoint', this.ThreadID));
                }
            });
        } else {
            this.sendEvent(new TerminatedEvent());
        }
    }

    protected async restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments) {
        if (this.gdb.isStopped()) {
            this.gdb.sendCommand('reset', 'null').then((result) => {
                if (result.resultType === 'done') {
                    this.sendEvent(new ContinuedEvent(this.ThreadID, true));
                    this.gdb.continue().then(() => {
                        this.sendEvent(new StoppedEvent('breakpoint', this.ThreadID));
                    });
                    this.sendResponse(response);
                }
            });
        } else {
            this.sendResponse(response);
        }
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {

        const bpList: DebugProtocol.SourceBreakpoint[] = args.breakpoints || [];

        response.body = {
            breakpoints: []
        };

        const file: string | undefined = args.source.path || args.source.name;

        if (file === undefined) {
            this.sendResponse(response);
            this.warn(`set breakpoint on 'undefine' path`);
            return;
        }

        // connected device
        if (this.isConnected) {

            // clear all
            if (this.bpMap.has(file)) {
                const cList = (<IGDB.Breakpoint[]>this.bpMap.get(file)).map((bkpt) => {
                    return <number>bkpt.number;
                });
                await this.gdb.removeBreakpoints(cList);
            }

            const validList: IGDB.Breakpoint[] = [];

            for (const bp of bpList) {

                const bkpt = await this.gdb.addBreakPoint({
                    file: this.toRelative(file),
                    line: bp.line,
                    condition: bp.condition
                });

                if (bkpt) {
                    validList.push(bkpt);
                    response.body.breakpoints.push({
                        line: bkpt.line,
                        id: bkpt.number,
                        source: this.createSource(file),
                        verified: true
                    });
                }
            }

            // update
            this.bpMap.set(file, validList);

        } else {
            this.preLoadBPMap.set(file, bpList.map((bpItem) => {
                return <IGDB.Breakpoint>{
                    line: bpItem.line,
                    condition: bpItem.condition,
                    file: this.toRelative(file)
                };
            }));
        }

        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

        response.body = {
            threads: [{
                id: this.ThreadID,
                name: 'MainThread'
            }]
        };

        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : 100;
        const endFrame = startFrame + maxLevels;

        // clear frame data
        this.frameChanged = true;
        this.funcArguments = [];

        // clear all variables
        this.vClearAll();

        this.gdb.getStack(startFrame, endFrame).then((stack) => {

            // init current frame's params
            if (stack.length > 0) {
                this.funcArguments = stack[0].paramsList || [];
            }

            response.body = {

                stackFrames: stack.map((frame) => {

                    const funcName: string = frame.address ?
                        (`${frame.address} ${frame.function}`) : frame.function;

                    return <DebugProtocol.StackFrame>{
                        id: frame.level,
                        name: funcName,
                        line: frame.line || 0,
                        source: frame.file ? this.createSource(frame.file) : undefined,
                        column: 0,
                    };
                }),
                totalFrames: stack.length
            };

            this.sendResponse(response);
        });
    }

    protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {

        // storage global variables
        const vDefines = await this.gdb.getGlobalVariables();
        if (vDefines) {
            this.globalVars = vDefines.map((item) => { return item.name; });
        }

        response.body = {
            scopes: [
                new Scope("Globals", ScopeType.SCOPE_GLOBAL, true),
                new Scope("Locals", ScopeType.SCOPE_LOCAL, false),
                new Scope("Arguments", ScopeType.SCOPE_FUNC_PARAMS, false),
                new Scope("Registers", ScopeType.SCOPE_REGISTER, true)
            ]
        };

        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {

        response.body = { variables: [] };

        // is scope
        if (args.variablesReference < DebugAdapter.HANLER_START) {

            // update func arguments
            if (this.frameChanged) {
                this.frameChanged = false;
                const funcArguments = this.funcArguments.map((_var) => { return this.vToVariable(_var); });
                this.rootVariables.set(ScopeType.SCOPE_FUNC_PARAMS, funcArguments);
            }

            const scopeType = <ScopeType>args.variablesReference;

            switch (scopeType) {
                case ScopeType.SCOPE_GLOBAL:
                    for (const name of this.globalVars) {
                        const _var = await this.gdb.getVariableValue(name);
                        if (_var) {
                            response.body.variables.push(this.vToVariable(_var));
                        }
                    }
                    break;
                case ScopeType.SCOPE_LOCAL:
                    const variables = await this.gdb.getLocalVariables();
                    if (variables) {
                        response.body.variables = variables.map((_var) => {
                            return this.vToVariable(_var);
                        });
                    }
                    break;
                case ScopeType.SCOPE_REGISTER:
                    const vList = await this.gdb.getRegisterVariables();
                    if (vList) {
                        response.body.variables = vList.map((_v) => {
                            return this.vToVariable(_v);
                        });
                    }
                    break;
                case ScopeType.SCOPE_FUNC_PARAMS:
                    response.body.variables = this.rootVariables.get(scopeType) || [];
                    break;
                default:
                    break;
            }

            // update scope var root
            this.rootVariables.set(scopeType, response.body.variables);
            this.sendResponse(response);

        } else {
            response.body.variables = this.vGetChildren(args.variablesReference);
            this.sendResponse(response);
        }
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this.gdb.continue().then(() => {
            this.sendEvent(new StoppedEvent('breakpoint', this.ThreadID));
        });
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) {
        this.gdb.step().then(() => {
            this.sendEvent(new StoppedEvent('step', this.ThreadID));
        });
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) {
        this.gdb.stepOut().then(() => {
            this.sendEvent(new StoppedEvent('step', this.ThreadID));
        });
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
        this.gdb.next().then(() => {
            this.sendEvent(new StoppedEvent('step', this.ThreadID));
        });
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments) {
        this.gdb.interrupt().then((bkpt) => {
            if (bkpt) {
                this.sendResponse(response);
                this.sendEvent(new StoppedEvent('pause', this.ThreadID));
            }
        });
    }

    private searchVariable(expression: string, frameID?: number): DebugProtocol.Variable | undefined {

        let nameList: string[] = expression.split(/\.|->/).filter((name) => { return name !== ''; });
        if (nameList.length === 0) {
            return;
        }

        nameList = nameList.reverse();
        const rootVariable = this.vGetRoot(<string>nameList.pop());
        let result: DebugProtocol.Variable | undefined;

        if (rootVariable) {

            if (nameList.length === 0) {
                return rootVariable;
            }

            result = rootVariable;
            while (nameList.length > 0 && result !== undefined) {
                const children = this.vGetChildren((<Variable>result).variablesReference);
                const name = <string>nameList.pop();
                const index = children.findIndex((v) => { return v.name === name; });
                if (index !== -1) {
                    result = children[index];
                } else {
                    result = undefined;
                }
            }
        }

        return result;
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        if (args.context === 'hover') {
            const _var = this.searchVariable(args.expression);
            if (_var) {
                response.body = {
                    result: _var.value,
                    variablesReference: _var.variablesReference,
                    presentationHint: { kind: 'property' }
                };
                this.sendResponse(response);
            }
        }
    }
}


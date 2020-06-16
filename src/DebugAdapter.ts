import {
    DebugSession, OutputEvent, TerminatedEvent, Source, Scope, Handles,
    StoppedEvent, InitializedEvent, BreakpointEvent, Breakpoint, ContinuedEvent
} from 'vscode-debugadapter';
import * as vsDebugAdapter from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { GDB } from './gdb/gdb';
import * as IGDB from './gdb/IGDB';
import { ResourceManager } from './ResourceManager';
import { File } from '../lib/node-utility/File';
import { EventEmitter } from 'events';
import * as NodePath from 'path';
import * as vscode from 'vscode';
import { GlobalEvent } from './GlobalEvent';
import * as util from 'util';

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
    svdFile?: string;
    runToMain?: boolean;
}

interface RegisterField {
    name: string;
    bitsOffset: number;
    bitsWidth: number;
}

interface PeriphRegister {
    name: string;
    baseAddress?: string;
    bytes: number;
    fields?: RegisterField[];
}

interface Peripheral {
    name: string;
    baseAddress: string;
    registers: PeriphRegister[];
}

interface SvdFilter {
    file: File;
    regexp: RegExp;
}

enum ScopeType {
    SCOPE_GLOBAL = 1, // ID must > 0
    SCOPE_LOCAL,
    SCOPE_FUNC_PARAMS,
    SCOPE_REGISTER,
    SCOPE_PERIPHERAL
}

// override Variable
class Variable extends vsDebugAdapter.Variable {
    vPath?: string;
}

interface MemoryInfo {
    addr: string;
    end: string;
    size: string;
}

export class DebugAdapter extends DebugSession implements vscode.TextDocumentContentProvider {

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

    private periphReferanceMap: Map<number, string> = new Map();
    private peripherals: Peripheral[] = [];
    private periphRegValueMap: Map<string, number> = new Map();

    // current frame information
    private frameChanged = false;
    private funcArguments: IGDB.Variable[] = [];

    private bpMap: Map<string, IGDB.Breakpoint[]> = new Map();
    private preLoadBPMap: Map<string, IGDB.Breakpoint[]> = new Map();

    private timeUsed: number | undefined;

    // disassembly document
    disassemblyScheme: string;
    assemblyMatcher = {
        'normal': /^(0x[0-9a-f]+)\s+(<[^>]+>:)\s+(?:0x[0-9a-f]+)\s+(.*?)\s*$/i,
        'simple': /^(0x[0-9a-f]+):\s+(?:0x[0-9a-f]+)\s+(.*?)\s*$/i
    };
    disassemblyBuf: Map<string, string[]>;
    assemblyTextEvent: vscode.EventEmitter<vscode.Uri>;
    onDidChange: vscode.Event<vscode.Uri>;

    constructor() {
        super();

        this.vHandles = new Handles(DebugAdapter.HANLER_START);
        this.cwd = <File>ResourceManager.getInstance().getWorkspaceDir();
        this.gdb = new GDB(ResourceManager.getInstance().isVerboseMode());
        this.stringAsArray = ResourceManager.getInstance().isParseString2Array();

        this.disassemblyScheme = ResourceManager.getInstance().getAppName();
        this.assemblyTextEvent = new vscode.EventEmitter();
        this.onDidChange = this.assemblyTextEvent.event;
        this.disassemblyBuf = new Map();

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

    //----- variables

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
        return this.vHandles.get(ref, []);
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

    //------ source

    private createSource(_path: string): Source {
        if (NodePath.isAbsolute(_path)) {
            return new Source(NodePath.basename(_path), _path);
        } else {
            const absPath = NodePath.join(this.cwd.path, _path);
            return new Source(NodePath.basename(absPath), absPath);
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

    //------ svd

    private loadSvd(fPath: string) {

        const svdFile = new File(fPath);

        if (!svdFile.IsFile()) {
            throw new Error(`not found file: ${svdFile.path}`);
        }

        try {
            this.peripherals = <Peripheral[]>JSON.parse(svdFile.Read());
        } catch (e) {
            throw new Error(`incorrect json file format: ${(<Error>e).message}`);
        }

        try {
            // check data format
            this.peripherals.forEach((periph, index) => {

                if (typeof periph.name !== 'string') {
                    throw new Error(`'name' must be a string, peripheral index: ${index}`);
                }

                if (typeof periph.baseAddress !== 'string') {
                    throw new Error(`'baseAddress' must be a string, at peripheral: ${periph.name}`);
                }

                if (!Array.isArray(periph.registers)) {
                    throw new Error(`'registers' must be a array, at peripheral: ${periph.name}`);
                }

                let baseAddress = parseInt(periph.baseAddress);
                let offset = 0;

                periph.registers.forEach((reg, rIndex) => {

                    if (typeof reg.name !== 'string') {
                        throw new Error(`'name' must be a string, at peripheral: ${periph.name}, register index: ${rIndex}`);
                    }

                    if (typeof reg.bytes !== 'number') {
                        throw new Error(`'bytes' must be a number, at peripheral: ${periph.name}, register: ${reg.name}`);
                    }

                    if (typeof reg.baseAddress !== 'string' && typeof reg.baseAddress !== 'undefined') {
                        throw new Error(`'baseAddress' must be string or undefined, at peripheral: ${periph.name}, register: ${reg.name}`);
                    }

                    if (!Array.isArray(reg.fields) && typeof reg.fields !== 'undefined') {
                        throw new Error(`'fields' must be array or undefined, at peripheral: ${periph.name}, register: ${reg.name}`);
                    }

                    if (reg.fields) {
                        reg.fields.forEach((field) => {

                            if (typeof field.name !== 'string') {
                                throw new Error(`'fields' format error, at peripheral: ${periph.name}, register: ${reg.name}`);
                            }

                            if (typeof field.bitsOffset !== 'number') {
                                throw new Error(`'fields' format error, at peripheral: ${periph.name}, register: ${reg.name}`);
                            }

                            if (typeof field.bitsWidth !== 'number') {
                                throw new Error(`'fields' format error, at peripheral: ${periph.name}, register: ${reg.name}`);
                            }
                        });
                    }

                    // fill register address
                    if (reg.baseAddress) {
                        baseAddress = parseInt(reg.baseAddress);
                        offset = 1;
                    } else {
                        reg.baseAddress = `0x${(baseAddress + offset).toString(16)}`;
                        offset++;
                    }
                });
            });
        } catch (error) {
            this.peripherals = [];
            throw error;
        }
    }

    private getSVDFilter(): SvdFilter[] {
        return ResourceManager.getInstance()
            .getSvdDir().GetList([/\.svd\.json$/], File.EMPTY_FILTER)
            .map((file) => {
                const cpuName = file.name.split('.')[0];
                return {
                    file: file,
                    regexp: new RegExp(`^${cpuName}`, 'i')
                };
            });
    }

    private periphToVariables(): Variable[] {

        // clear ptr map, value cache
        this.periphReferanceMap.clear();
        this.periphRegValueMap.clear();

        return this.peripherals.map((periph) => {

            const vPeriph = new Variable(`${periph.name}`,
                `address ${periph.baseAddress}`, DebugAdapter.HANLER_NULL);

            vPeriph.vPath = periph.name;

            vPeriph.variablesReference = this.vHandles.create(periph.registers.map((register) => {

                const vReg = new Variable(register.name, 'null', DebugAdapter.HANLER_NULL);

                vReg.vPath = `${vPeriph.vPath}.${register.name}`;

                const children = register.fields?.map((field) => {
                    const vField = new Variable(field.name, 'null', DebugAdapter.HANLER_NULL);
                    vField.vPath = `${vReg.vPath}.${field.name}`;
                    return vField;
                });

                if (children) {
                    vReg.variablesReference = this.vHandles.create(children);
                    // add ptr to mapper
                    this.periphReferanceMap.set(vReg.variablesReference, vReg.vPath);
                }

                return vReg;
            }));

            // add ptr to mapper
            this.periphReferanceMap.set(vPeriph.variablesReference, vPeriph.vPath);

            return vPeriph;
        });
    }

    private isPeriphRef(ref: number): boolean {
        return this.periphReferanceMap.has(ref);
    }

    private getPeriphByPath(vPath: string): Peripheral | PeriphRegister | RegisterField | undefined {

        const nameList = vPath.split('.');

        // search peripheral
        if (nameList.length > 0) {
            const pIndex = this.peripherals.findIndex((periph) => { return periph.name === nameList[0]; });
            if (pIndex !== -1) {
                const periph = this.peripherals[pIndex];

                // search register
                if (nameList.length > 1) {
                    const regIndex = periph.registers.findIndex((reg) => { return reg.name === nameList[1]; });
                    if (regIndex !== -1) {
                        const register = periph.registers[regIndex];

                        // search fields
                        if (nameList.length > 2) {
                            if (register.fields) {
                                const fIndex = register.fields.findIndex((field) => { return field.name === nameList[2]; });
                                if (fIndex !== -1) {
                                    return register.fields[fIndex];
                                }
                            }
                        } else {
                            return register;
                        }
                    }
                } else {
                    return periph;
                }
            }
        }
    }

    private async readPeriphRegisters(ref: number): Promise<Variable[]> {

        const resultList: Variable[] = [];
        const reqList: Variable[] = this.vHandles.get(ref, []);

        for (const reqVar of reqList) {
            if (reqVar.vPath) {
                const nameList = reqVar.vPath.split('.');
                // is registers
                if (nameList.length === 2) {

                    const register = <PeriphRegister>this.getPeriphByPath(reqVar.vPath);
                    if (register) {
                        const baseAddress = parseInt(<string>register.baseAddress);
                        const mem = await this.gdb.readMemory(baseAddress, register.bytes);

                        // check address, length
                        if (mem.addr === baseAddress &&
                            mem.buf.length === register.bytes) {

                            // set value
                            if (mem.buf.length === 1) {
                                reqVar.value = `0x${mem.buf[0].toString(16)}`;
                                // cache
                                this.periphRegValueMap.set(reqVar.vPath, mem.buf[0]);
                            } else {
                                const hexList = mem.buf.map((num) => { return `0x${num.toString(16)}`; });
                                reqVar.value = `[${hexList.join(',')}]`;
                            }
                        } else {
                            // clear cache
                            this.periphRegValueMap.delete(reqVar.vPath);
                        }
                    }

                    resultList.push(reqVar);
                }
                // is fields
                else if (nameList.length === 3) {

                    const regValue = this.periphRegValueMap.get(`${nameList[0]}.${nameList[1]}`);
                    const field = <RegisterField>this.getPeriphByPath(reqVar.vPath);

                    if (field && typeof regValue !== 'undefined') {
                        let mask = 0; // bit mask
                        for (let i = 0; i < field.bitsWidth; i++) {
                            mask = (mask << 1) | 1;
                        }
                        const fieldValue = (regValue >> field.bitsOffset) & mask;
                        reqVar.value = `0x${fieldValue.toString(16)}`;
                        resultList.push(reqVar);
                    }
                }
            }
        }

        return resultList;
    }

    //----- disassembly

    private async disassembleRange(start: string, length: string): Promise<string[] | undefined> {
        const lines = await this.gdb.readDisassembly(`${start},+${length}`);
        if (lines) {
            return lines;
        }
    }

    private splitInstructionLine(line: string): { instruction: string, comment: string } | undefined {
        const wsIndex = line.search(/\s/);
        if (wsIndex !== -1) {
            const instName = line.substring(0, wsIndex);
            const nInstIndex = line.indexOf(instName, wsIndex);
            if (nInstIndex !== -1) {
                return {
                    instruction: line.substring(0, nInstIndex).trim(),
                    comment: line.substring(nInstIndex).trim()
                };
            }
        }
    }

    provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {

        const lines = this.disassemblyBuf.get(uri.toString());
        if (lines) {

            const resList: { addr: string, txt: string, inst: string, com: string }[] = [];
            let maxTextLen: number = 0;
            let maxInstLen: number = 0;

            lines.forEach((line) => {

                /**
                 * 0x0080aef <Main+4>: 0x20DF PUSH A PUSH A
                */
                let mList = this.assemblyMatcher['normal'].exec(line);
                if (mList && mList.length > 3) {

                    const pair = this.splitInstructionLine(mList[3]);
                    if (pair) {
                        // add line
                        maxInstLen = pair.instruction.length > maxInstLen ? pair.instruction.length : maxInstLen;
                        maxTextLen = mList[2].length > maxTextLen ? mList[2].length : maxTextLen;
                        resList.push({ addr: mList[1], txt: mList[2], inst: pair.instruction, com: pair.comment });
                        return;
                    }

                    // add line
                    maxTextLen = mList[2].length > maxTextLen ? mList[2].length : maxTextLen;
                    resList.push({ addr: mList[1], txt: mList[2], inst: mList[3], com: '' });
                    return;
                }

                /**
                 * 0x0080aef: 0x20DF PUSH A PUSH A
                */
                mList = this.assemblyMatcher['simple'].exec(line);
                if (mList && mList.length > 2) {

                    const pair = this.splitInstructionLine(mList[2]);
                    if (pair) {
                        maxInstLen = pair.instruction.length > maxInstLen ? pair.instruction.length : maxInstLen;
                        resList.push({ addr: mList[1], txt: '', inst: pair.instruction, com: pair.comment });
                        return;
                    }

                    // add line
                    resList.push({ addr: mList[1], txt: '', inst: mList[2], com: '' });
                    return;
                }

                // add line
                resList.push({ addr: line, txt: '', inst: '', com: '' });
                return;
            });

            // convert line
            return resList.map((info) => {
                return `${info.addr}\t${info.txt.padEnd(maxTextLen)}\t${info.inst.padEnd(maxInstLen)}\t; ${info.com}`;
            }).join('\r\n');
        }
    }

    //----- fill memory

    private parseMemoryLayout(lines: string[]): { ram?: MemoryInfo, flash?: MemoryInfo } {
        const result: { ram?: MemoryInfo, flash?: MemoryInfo } = Object.create(null);
        const matcher = /^\[(0x[0-9a-f]+)-(0x[0-9a-f]+)\]:(\w+)$/i;
        for (const line of lines) {
            const mList = matcher.exec(line);
            if (mList && mList.length > 3) {
                switch (mList[3].toLocaleLowerCase()) {
                    case 'ram':
                        result.ram = {
                            addr: mList[1],
                            end: mList[2],
                            size: '0x' + (parseInt(mList[2]) - parseInt(mList[1]) + 1).toString(16)
                        };
                        break;
                    case 'flash':
                        result.flash = {
                            addr: mList[1],
                            end: mList[2],
                            size: '0x' + (parseInt(mList[2]) - parseInt(mList[1]) + 1).toString(16)
                        };
                        break;
                    default:
                        break;
                }
            }
        }
        return result;
    }


    //=================================================

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

        this.log(`==================== Initialize ====================\r\n`);

        const resManager = ResourceManager.getInstance();
        const gdbPath = resManager
            .getBinDir().path + File.sep + 'gdb.exe';

        // clear log
        const logFile = File.fromArray([resManager.getBinDir().path, 'swim', 'Error.log']);
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
        this.log('[SEND]: kill gdb.exe');
        await this.gdb.kill();
        this.log('\tdone');
        this.log('[END]');
        GlobalEvent.emit('debug.terminal');
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
        }, 100);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArguments) {

        // wait until configuration has finished (and configurationDoneRequest has been called)
        await this.configDoneEmitter.wait();

        // load svd
        try {
            if (args.svdFile) {
                const absPath: string = NodePath.isAbsolute(args.svdFile)
                    ? args.svdFile : NodePath.normalize(`${this.cwd.path}${File.sep}${args.svdFile}`);
                this.log(`Load SVD: ${args.svdFile}`);
                this.loadSvd(absPath);
            } else {
                const filters = this.getSVDFilter();
                const index = filters.findIndex((item) => { return item.regexp.test(args.cpu); });
                if (index !== -1) {
                    this.log(`Load SVD: ${filters[index].file.name}`);
                    this.loadSvd(filters[index].file.path);
                }
            }
        } catch (e) {
            this.error(`Load SVD failed !, msg: ${(<Error>e).message}`);
        }

        // connect to gdb
        this.log(`\r\n==================== Connect ====================\r\n`);
        this.isConnected = await this.gdb.connect(args);
        if (this.isConnected) {

            // other custom commands
            const extraCommands: string[] = [];

            if (args.runToMain !== false) {
                extraCommands.push('break main');
            }

            this.log(`\r\n==================== Launch ====================\r\n`);
            const launched = await this.gdb.launch(args.executable, extraCommands);
            if (launched) {
                this.sendResponse(response);
                await this.loadBreakPoints();
                const bkpt = await this.gdb.continue();
                if (bkpt) {
                    this.sendEvent(new StoppedEvent(args.runToMain !== false ? 'entry' : 'breakpoint', this.ThreadID));
                }
                return;
            }
        }

        // launch failed, exit
        this.sendEvent(new TerminatedEvent());
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

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {

        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : 100;
        const endFrame = startFrame + maxLevels;

        // clear frame data
        this.frameChanged = true;
        this.funcArguments = [];

        // clear all variables
        this.vClearAll();

        const stack = await this.gdb.getStack(startFrame, endFrame);

        // init current frame function arguments
        if (stack.length > 0) {
            this.funcArguments = stack[0].paramsList || [];
        }

        // send Elapsed time event
        if (this.timeUsed !== undefined && stack.length > 0) {
            if (stack[0].line !== null && stack[0].file) {
                GlobalEvent.emit('debug.onStopped', {
                    file: this.createSource(stack[0].file).path,
                    line: stack[0].line - 1, // to zero base
                    useTimeMs: this.timeUsed
                });
            }
            this.timeUsed = undefined;
        }

        const stackFrames: DebugProtocol.StackFrame[] = [];

        for (let index = 0; index < stack.length; index++) {
            const frame = stack[index];

            if (util.isNullOrUndefined(frame.file) && frame.address) {

                const prevInstructionOffset = 10;
                const instructionLen = 30;

                let line: number | undefined;
                let fileName: string | undefined;
                let asmFileUri: string | undefined;
                let cAddress: number = parseInt(frame.address);

                const realStartAddr = cAddress >= prevInstructionOffset ? (cAddress - prevInstructionOffset) : 0;
                const addrStart: string = `0x${realStartAddr.toString(16)}`;
                const asmLines = await this.disassembleRange(addrStart, instructionLen.toString());

                if (asmLines) {
                    const fileName = `${frame.address}.stm8asm`;
                    asmFileUri = `${this.disassemblyScheme}:${encodeURIComponent(fileName)}`;
                    const bkptReg = new RegExp(`${frame.address}`);
                    line = asmLines.findIndex((line) => { return bkptReg.test(line); }) + 1;
                    this.disassemblyBuf.set(asmFileUri, asmLines);
                    this.assemblyTextEvent.fire(vscode.Uri.parse(asmFileUri));
                }

                stackFrames.push(<DebugProtocol.StackFrame>{
                    id: frame.level,
                    name: `${frame.address} ${frame.function}`,
                    line: line || 0,
                    source: asmFileUri ? new Source(<string>fileName, asmFileUri) : undefined,
                    column: 0,
                });

            } else {

                const frameName: string = frame.address ?
                    (`${frame.address} ${frame.function}`) : frame.function;

                stackFrames.push(<DebugProtocol.StackFrame>{
                    id: frame.level,
                    name: frameName,
                    line: frame.line || 0,
                    source: frame.file ? this.createSource(frame.file) : undefined,
                    column: 0,
                });
            }
        }

        response.body = {

            stackFrames: stackFrames,

            totalFrames: stack.length
        };

        this.sendResponse(response);
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
                new Scope("Registers", ScopeType.SCOPE_REGISTER, true),
                new Scope('Peripherals', ScopeType.SCOPE_PERIPHERAL, true)
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
                case ScopeType.SCOPE_PERIPHERAL:
                    response.body.variables = this.periphToVariables();
                    break;
                default:
                    break;
            }

            // update scope var root
            this.rootVariables.set(scopeType, response.body.variables);
            this.sendResponse(response);
            return;
        }

        // is peripheral
        if (this.isPeriphRef(args.variablesReference)) {
            response.body.variables = await this.readPeriphRegisters(args.variablesReference);
            this.sendResponse(response);
            return;
        }

        // is variable
        response.body.variables = this.vGetChildren(args.variablesReference);
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this.gdb.continue().then(() => {
            this.timeUsed = this.gdb.getCommandTimeUsage();
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
            this.timeUsed = this.gdb.getCommandTimeUsage();
            this.sendEvent(new StoppedEvent('step', this.ThreadID));
        });
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
        this.gdb.next().then(() => {
            this.timeUsed = this.gdb.getCommandTimeUsage();
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

    protected disassembleRequest(response: DebugProtocol.DisassembleResponse,
        args: DebugProtocol.DisassembleArguments, request?: DebugProtocol.Request): void {
        // no support now
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

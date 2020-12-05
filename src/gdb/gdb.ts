import { IGDB, GdbResult, Breakpoint, Stack, Variable, ErrorMsg, VariableDefine, ResultData, ConnectOption, LogType, LogData, Memory, CustomCommandResult, GdbAdapter } from "./IGDB";
import { EventEmitter } from 'events';
import { Executable, ExeFile, ExeCmd } from '../../lib/node-utility/Executable';
import * as path from 'path';
import { Writable, Readable } from "stream";
import { ResourceManager } from "../ResourceManager";
import { File } from "../../lib/node-utility/File";
import * as child_process from 'child_process';
import { kill } from "../platform";
import { EOL } from "os";
import { isNullOrUndefined } from "util";

export class GDB implements IGDB {

    private readonly SIGNAL_INTRRUPT: NodeJS.Signals = 'SIGINT';

    protected _event: EventEmitter;
    private parser: GdbParser;
    private cmdQueue: CommandQueue;
    private gdbAdapter: GdbAdapter = <any>null;

    private nextID: number = 0;
    private hiddenMsgType?: LogType;
    private prevTimeUsage: number | undefined;
    private stopped: boolean;

    on(event: 'log', lisenter: (data: LogData) => void): void;
    on(event: any, lisenter: (arg: any) => void): void {
        this._event.on(event, lisenter);
    }

    //--------

    constructor(verbose?: boolean) {
        this._event = new EventEmitter();
        this.parser = new GdbParser(this);
        this.cmdQueue = new CommandQueue();
        this.stopped = false;
        this.hiddenMsgType = verbose ? 'log' : 'hide';
    }

    private log(label: LogType, msg: string): void {
        this._event.emit('log', <LogData>{
            type: label,
            msg: msg
        });
    }

    private obtainID(): number {
        return this.nextID++;
    }

    //--

    initAdapter(adapter: GdbAdapter) {
        this.gdbAdapter = adapter;
    }

    getAdapter(): GdbAdapter {
        return this.gdbAdapter;
    }

    async connect(option: ConnectOption): Promise<boolean> {

        const errMsg = await this.gdbAdapter.onConnect(option);
        if (errMsg) {
            return false;
        }

        const commandList = this.gdbAdapter.getConnectCommands(option);

        for (const cmd of commandList) {
            const res = await this.sendCommand(cmd, this.connect.name);
            if (res.resultType === 'failed') {
                return false;
            }
        }

        // user's command
        if (option.customCommands) {
            for (const customCmd of option.customCommands) {
                await this.sendCommand(customCmd, this.connect.name);
            }
        }

        return true;
    }

    async disconnect(): Promise<void> {

        const commandList = this.gdbAdapter.getDisconnectCommands();

        for (const cmd of commandList) {
            await this.sendCommand(cmd, this.disconnect.name, 'log');
        }
    }

    async startDebug(executable: string, otherCommand?: string[] | undefined): Promise<boolean> {

        const commandList = this.gdbAdapter.getStartDebugCommands(executable);

        for (const cmd of commandList) {
            const res = await this.sendCommand(cmd, this.startDebug.name);
            if (res.resultType === 'failed') {
                return false;
            }
        }

        if (otherCommand) {
            for (const cmd of otherCommand) {
                await this.sendCommand(cmd, this.startDebug.name, 'hide');
            }
        }

        return true;
    }

    async launch(args?: string[] | undefined): Promise<ErrorMsg | null> {

        this.cmdQueue.on('error', (err) => {
            this.log('error', `${err.message} : \r\n${err.stack}`);
        });

        // log launch msg
        const launchHandler = (data: CommandResult) => {
            if (data.id === CommandQueue.NULL_ID) {
                this.cmdQueue.removeListener('frame', launchHandler);
                if (data.lines.length > 0) {
                    this.log('warning', data.lines.join('\r\n'));
                }
            }
        };

        this.cmdQueue.on('frame', launchHandler);

        return await this.cmdQueue.launch(this.gdbAdapter.getExePath(), args);
    }

    async kill(): Promise<void> {
        await this.gdbAdapter.onKill();
        await this.cmdQueue.kill();
    }

    sendCommand(command: string, funcName: string, logType: LogType = 'log'): Promise<GdbResult> {

        return new Promise((resolve) => {

            const id = this.obtainID();

            const dathandler = (data: CommandResult) => {
                if (data.id === id) {

                    const lines = data.lines;
                    this.cmdQueue.removeListener('frame', dathandler);

                    // set command's time usage
                    this.prevTimeUsage = data.timeUsage;

                    try {
                        const result = this.parser.parse(funcName, lines);

                        if (result.resultType === 'failed') {
                            this.log('error', `[ERROR]: ${command}`);
                            this.log('error', lines.map((ln) => { return `\t${ln}`; }).join('\r\n'));
                            this.log('error', '[END]');
                        }
                        else if (logType !== 'hide') {
                            this.log(logType, `[SEND]: ${command}`);
                            this.log(logType, lines.map((ln) => { return `\t${ln}`; }).join('\r\n'));
                            this.log(logType, '[END]');
                        }

                        resolve(result);

                    } catch (error) {

                        const rData = new ResultData();
                        this.log('error', `[Parser Error]: ${(<Error>error).message}`);

                        resolve({
                            resultType: 'failed',
                            error: `parse error: ${(<Error>error).message}`,
                            data: rData,
                            logs: []
                        });
                    }
                }
            };

            this.cmdQueue.on('frame', dathandler);
            this.cmdQueue.once('write-done', (data) => {
                if (data.id === id && data.err) {
                    this.log('error', data.err.message);
                    resolve({
                        resultType: 'failed',
                        data: Object.create(null),
                        error: data.err.message,
                        logs: []
                    });
                }
            });

            this.cmdQueue.writeLine(id, `${command}`);
        });
    }

    getCommandTimeUsage(): number | undefined {
        return this.prevTimeUsage;
    }

    isStopped(): boolean {
        return this.stopped;
    }

    /**
     * ctrl+c
     * 
     * Program received signal SIGSTOP, Stopped (signal).
     * warning: User stop
     * DelayMs (ms=464) at c:\Users\admin_cl\Desktop\test\test_C51\multi-project\stm8_demo\lib\delay\stm8s_delay.c:31
     * 31              while ((TIM4->SR1 & (uint8_t)TIM4_FLAG_UPDATE) == 0)
    */
    interrupt(): Promise<Breakpoint> {
        return new Promise((resolve, reject) => {

            this.stopped = false;

            const dataHander = (lines: string[]) => {
                const result = this.parser.parse(this.continue.name, lines);
                if (result.data.bkpt['line'] !== undefined) {
                    this.stopped = true;
                    this.cmdQueue.removeListener('standalone-data', dataHander);
                    resolve(result.data.bkpt);
                }
            };
            
            this.cmdQueue.on('standalone-data', dataHander); // wait breakpoint hit

            this.sendCommand('interrupt', this.interrupt.name, 'warning').then((result) => {
                // interrupt ok
            }, reject);
        });
    }

    /**
     * Breakpoint 1, main () at c:\Users\admin_cl\Desktop\test\test_C51\multi-project\stm8_demo\src\main.c:40
    */
    continue(): Promise<Breakpoint> {
        return new Promise((resolve, reject) => {

            this.stopped = false;

            const dataHander = (lines: string[]) => {
                const result = this.parser.parse(this.continue.name, lines);
                if (result.data.bkpt['line'] !== undefined) {
                    this.stopped = true;
                    this.cmdQueue.removeListener('standalone-data', dataHander);
                    resolve(result.data.bkpt);
                }
            };
            
            this.cmdQueue.on('standalone-data', dataHander); // wait breakpoint hit

            this.sendCommand('continue&', this.continue.name, 'warning').then((result) => {
                // continue ok
            }, reject);
        });
    }

    /**
     * DelayInit () at c:\Users\admin_cl\Desktop\test\test_C51\multi-project\stm8_demo\lib\delay\stm8s_delay.c:5
    */
    next(instruction?: boolean): Promise<Breakpoint> {
        return new Promise((resolve, reject) => {
            this.stopped = false;
            this.sendCommand(instruction ? 'nexti' : 'next', this.next.name, 'warning').then((result) => {
                if (result.resultType === 'done') {
                    this.stopped = true;
                    resolve(result.data.bkpt);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    /**
     * 43          DelayInit();
     * 0x0086f5	56	    CLK_HSIPrescalerConfig(CLK_PRESCALER_HSIDIV1);
    */
    step(instruction?: boolean): Promise<Breakpoint> {
        return new Promise((resolve, reject) => {
            this.stopped = false;
            this.sendCommand(instruction ? 'stepi' : 'step', this.step.name, 'warning').then((result) => {
                if (result.resultType === 'done') {
                    this.stopped = true;
                    resolve(result.data.bkpt);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    /**
     * Run till exit from #0  DelayInit ()
     *      at c:\Users\admin_cl\Desktop\test\test_C51\multi-project\stm8_demo\lib\delay\stm8s_delay.c:5
     * main () at c:\Users\admin_cl\Desktop\test\test_C51\multi-project\stm8_demo\src\main.c:44
     * 44          LoggerInit();
    */
    stepOut(): Promise<Breakpoint> {
        return new Promise((resolve, reject) => {
            this.stopped = false;
            this.sendCommand('finish', this.stepOut.name, 'warning').then((result) => {
                if (result.resultType === 'done') {
                    this.stopped = true;
                    resolve(result.data.bkpt);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    /**
     * Breakpoint 1 at 0x81fa: file c:\Users\admin_cl\Desktop\test\test_C51\multi-project\stm8_demo\src\main.c, line 40.
     * 
     * /^Breakpoint (\d+) [^:]+: file ([^,]+), line (\d+)/
    */
    addBreakPoint(breakpoint: Breakpoint): Promise<Breakpoint> {
        return new Promise((resolve, reject) => {

            let commandLine: string = `break ${breakpoint.file}:${breakpoint.line}`;

            if (breakpoint.condition) {
                commandLine += ` if ${breakpoint.condition}`;
            }

            this.sendCommand(commandLine, this.addBreakPoint.name, this.hiddenMsgType).then((result) => {
                if (result.resultType === 'done' && result.data.bkpt['number']) {
                    resolve(result.data.bkpt);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    removeBreakpoints(breakpoints: number[]): Promise<boolean> {
        return new Promise((resolve, reject) => {
            this.sendCommand(`delete breakpoints ${breakpoints.join(' ')}`,
                this.removeBreakpoints.name, this.hiddenMsgType).then((result) => {
                    resolve(result.resultType === 'done');
                }, reject);
        });
    }

    getStack(startFrame: number, endFrame: number): Promise<Stack[]> {
        return new Promise((resolve, reject) => {
            this.sendCommand(`bt`, this.getStack.name, this.hiddenMsgType).then((result) => {
                const stack = result.data.stack || [];
                resolve(stack.slice(startFrame, endFrame));
            }, reject);
        });
    }

    /**
     * No locals.
     * clock = 16 '\020'
    */
    getLocalVariables(): Promise<Variable[]> {
        return new Promise((resolve, reject) => {
            this.sendCommand(`info locals`, this.getLocalVariables.name, this.hiddenMsgType).then((result) => {
                if (result.resultType === 'done') {
                    let variables: Variable[] = [];
                    if (result.data.var) {
                        variables = result.data.var;
                    }
                    resolve(variables);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    /**
     * All defined variables:
     * uint8_t HSIDivFactor[4];
     * 
     * Non-debugging symbols:
     * 0x00000000  $d
     * 0x00000000  ?b0
     * 0x00000000  ?l0
    */
    getGlobalVariables(): Promise<VariableDefine[]> {
        return new Promise((resolve, reject) => {
            this.sendCommand(`info variables`, this.getGlobalVariables.name, this.hiddenMsgType).then((result) => {
                if (result.resultType === 'done') {
                    let vDefs: VariableDefine[] = [];
                    if (result.data.varDef) {
                        vDefs = result.data.varDef;
                    }
                    resolve(vDefs);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    /*
    PC             0x6000   24576
    DATE_LIMIT     0x0      0
    SP_OVERFLOW    0x600    1536
    CPU_FREQUENCY  0x0      0
    X:A            0x0      0
    XH             0x0      0
    ?b0            0x0      0
    */
    getRegisterVariables(): Promise<Variable[]> {
        return new Promise((resolve, reject) => {
            this.sendCommand(`info registers`, this.getRegisterVariables.name, this.hiddenMsgType).then((result) => {
                if (result.resultType === 'done') {
                    let variables: Variable[] = [];
                    if (result.data.var) {
                        variables = result.data.var;
                    }
                    resolve(variables);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    /**
     * $1 = 16 '\020'
     */
    getVariableValue(name: string): Promise<Variable> {
        return new Promise((resolve, reject) => {
            this.sendCommand(`p ${name}`, this.getVariableValue.name, this.hiddenMsgType).then((result) => {
                if (result.resultType === 'done' && result.data.var) {
                    result.data.var[0].name = name;
                    resolve(result.data.var[0]);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    readMemory(addr: number, len: number): Promise<Memory> {
        return new Promise((resolve, reject) => {
            this.sendCommand(`x/${len}xb 0x${addr.toString(16)}`, this.readMemory.name, this.hiddenMsgType).then((result) => {
                if (result.resultType === 'done' && result.data.memory) {
                    resolve(result.data.memory);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    readDisassembly(params: string | { start: string, length: string }): Promise<string[]> {
        return new Promise((resolve, reject) => {
            const command: string = typeof params === 'string' ? params : (`${params.start},+${params.length}`);
            this.sendCommand(`disassemble ${command}`, this.readDisassembly.name, 'hide').then((result) => {
                if (result.resultType === 'done' && result.data.disassembly) {
                    resolve(result.data.disassembly);
                } else {
                    resolve();
                }
            }, reject);
        });
    }

    sendCustomCommand(command: string, showLog?: boolean): Promise<CustomCommandResult> {
        return new Promise((resolve, reject) => {
            this.sendCommand(command, this.sendCustomCommand.name, showLog ? this.hiddenMsgType : 'hide').then((result) => {
                resolve({
                    resultType: result.resultType,
                    lines: result.data.customLines || [],
                    error: result.error,
                    logs: result.logs
                });
            }, reject);
        });
    }
}

class Queue<T> {

    private list: T[];

    constructor() {
        this.list = [];
    }

    count(): number {
        return this.list.length;
    }

    enqueue(data: T) {
        this.list.push(data);
    }

    dequeue(): T | undefined {
        if (this.list.length > 0) {
            const data = this.list[0];
            this.list.splice(0, 1);
            return data;
        }
        return undefined;
    }
}

//---

interface CommandResult {
    id: number;
    lines: string[];
    timeUsage?: number;
}

interface CommandData {
    id: number;
    line: string;
}

interface WriteResult {
    id: number;
    err: Error | undefined | null;
}

class CommandQueue {

    public static readonly NULL_ID = -1;

    private _event: EventEmitter;
    private strBuf = new StringBuffer();

    private idQueue: Queue<number> = new Queue();
    private cmdQueue: Queue<CommandData> = new Queue();
    private writeBusy: boolean = false;

    private proc: Executable;
    private timer: Timer;

    constructor() {
        this._event = new EventEmitter();
        this.proc = new ExeFile();
        this.timer = new Timer();
    }

    launch(exe: string, args?: string[]): Promise<ErrorMsg | null> {

        return new Promise((resolve) => {

            this.proc.on('launch', (launchOk) => {
                if (launchOk) {
                    resolve();
                } else {
                    resolve('GDB launch failed !');
                }
            });

            this.proc.on('error', (err) => {
                this._event.emit('error', err);
            });

            this.proc.Run(exe, args, { encoding: 'utf8' });

            (<Readable>this.proc.stdout).on('data', this.onData.bind(this));
            (<Readable>this.proc.stderr).on('data', this.onData.bind(this));
        });
    }

    signal(id: number, sig: NodeJS.Signals) {
        this.idQueue.enqueue(id);
        this.proc.signal(sig);
    }

    getPid(): number | undefined {
        return this.proc.pid();
    }

    async kill() {
        const pid = this.proc.pid();
        if (pid) {
            kill(pid);
        }
    }

    on(event: 'error', lisenter: (err: Error) => void): void;
    on(event: 'standalone-data', lisenter: (lines: string[]) => void): void;
    on(event: 'frame', lisenter: (data: CommandResult) => void): void;
    on(event: any, lisenter: (arg: any) => void): void {
        this._event.on(event, lisenter);
    }

    once(event: 'write-done', lisenter: (result: WriteResult) => void): void;
    once(event: 'standalone-data', lisenter: (lines: string[]) => void): void;
    once(event: any, lisenter: (arg: any) => void): void {
        this._event.once(event, lisenter);
    }

    removeListener(event: 'standalone-data', listener: (lines: string[]) => void): void;
    removeListener(event: 'frame', listener: (data: CommandResult) => void): void;
    removeListener(event: any, listener: (argc: any) => void): void {
        this._event.removeListener(event, listener);
    }

    writeLine(id: number, line: string): void {

        this.idQueue.enqueue(id);

        if (this.writeBusy) {
            this.writeWait(id, `${line}\r\n`);
        } else {
            console.log(line); // log to console
            this.writeBusy = true;
            (<Writable>this.proc.stdin).write(`${line}\r\n`, (err) => {
                this.timer.start(`${id}`); // count time
                this._event.emit('write-done', <WriteResult>{ id: id, err: err });
            });
        }
    }

    private writeWait(id: number, line: string): void {
        this.cmdQueue.enqueue({ id: id, line: line });
    }

    private onData(chunk: string) {

        this.strBuf.append(chunk);

        // log to console
        console.log(chunk);

        if (this.strBuf.getLastLine().startsWith('(gdb)')) { // a gdb frame

            // get time usage
            const id = this.idQueue.count() > 0 ? <number>this.idQueue.dequeue() : CommandQueue.NULL_ID;
            const timeUsage = this.timer.stop(`${id}`);

            // send data
            const lines = this.strBuf.toList();
            this.strBuf.clear();
            lines.splice(lines.length - 1);
            this._event.emit('frame', <CommandResult>{
                id: id,
                lines: lines,
                timeUsage: timeUsage
            });

            // next one
            if (this.cmdQueue.count() > 0) {
                this.writeBusy = true;
                const data = <CommandData>this.cmdQueue.dequeue();
                console.log(data.line); // log to console
                (<Writable>this.proc.stdin).write(data.line, (err) => {
                    this.timer.start(`${data.id}`); // count time
                    this._event.emit('write-done', <WriteResult>{ id: data.id, err: err });
                });
            } else {
                this.writeBusy = false;
            }
        }
        else if (this.idQueue.count() === 0) { // standalone data
            this._event.emit('standalone-data', this.strBuf.toList());
        }
    }
}

class Timer {

    private timers: Map<string, number> = new Map();
    private defLable = 'timer.default';

    start(lable?: string) {
        this.timers.set(lable || this.defLable, process.uptime());
    }

    stop(lable?: string): number | undefined {
        const prevTime = this.timers.get(lable || this.defLable);
        if (prevTime) {
            const t = (process.uptime() - prevTime) * 1000;
            this.timers.delete(lable || this.defLable);
            return t;
        }
    }
}

class StringBuffer {

    private line_list: string[];
    private _event: EventEmitter;

    constructor() {
        this.line_list = [];
        this._event = new EventEmitter();
    }

    on(event: 'line', lisenter: (line: string) => void): void;
    on(event: any, lisenter: (param: any) => void): void {
        this._event.on(event, lisenter);
    }

    private emit(event: 'line', line: string): void;
    private emit(event: any, param: any): void {
        this._event.emit(event, param);
    }

    append(str: string): void {
        const nList = str.split(/\r\n|\n/);
        for (let line of nList) {
            if (line !== '') {
                this.line_list.push(line);
                this.emit('line', line);
            }
        }
    }

    toString(): string {
        return this.line_list.join(EOL);
    }

    toList(): string[] {
        return this.line_list;
    }

    getLastLine(): string {

        if (this.line_list.length > 0) {
            return this.line_list[this.line_list.length - 1];
        }

        return '';
    }

    clear() {
        this.line_list = [];
    }
}

interface CharTab {
    [name: string]: number;
}

class GdbParser {

    private gdb: GDB;

    private readonly transChartable: CharTab = {
        'a': 7,
        'b': 8,
        'f': 12,
        'n': 10,
        'r': 13,
        't': 9,
        'v': 11,
        '\\': 92,
        '\'': 39,
        '"': 34,
        '?': 63
    };

    private readonly regexpList = {
        'expression': /^\s*([\w\$]+)\s*=\s*(.+)$/,
        'varDefine': /(\w+)(?:\[\w+\])?(?:\s*=\s*[^;]+)?;$/,
        'register': /^([\w\:\?]+)\s*(0x[0-9a-f]+)\s*\d+$/,
        'vaildStack': /^#(\d+) (.*) (\S+) \((.*)\) at (.+):(\d+)$/i,
        'anonymousStack': /^#(\d+) (.*) (\S+ \(\))$/i,
        'stackAddress': /^(0x[0-9a-f]+) in$/i,
        'breakpoint': /^Breakpoint (\d+) [^:]+: file ([^,]+), line (\d+)/,
        'stopLine': /\S+ at (.+):(\d+)$/,
        'stopFunc': /(\d+)\s*\w+\s*\(.*\)\s*;$/,
        'memValues': /^(0x[0-9a-f]+)\b.*:\s*(.+)\s*$/i
    };

    private readonly valueMatcher = {
        'integer': /^\d+|0x[0-9a-f]+$/i,
        'float': /^\d+.\d+[ufld]$/i,
        'repeatedArray': /^\{.+ <repeats \d+ times>\}$/,
        'string': /^".*"$/,
        'objectValue': /^\{.+\}$/
    };

    constructor(gdb: GDB) {
        this.gdb = gdb;
    }

    private parseLine(funcName: string, line: string, result: GdbResult): void {

        // failed
        if (line.startsWith('Error')) {
            result.resultType = 'failed';
            result.error = line.replace('Error:', '').trim();
            return;
        }

        // Not available for current target.
        if (line.startsWith('Not available for current target')) {
            result.resultType = 'failed';
            result.error = line;
            return;
        }

        switch (funcName) {
            case this.gdb.step.name:
            case this.gdb.continue.name:
            case this.gdb.stepOut.name:
            case this.gdb.next.name:
            case this.gdb.interrupt.name:
                //... at c:\Users\admin_cl\Desktop\test\test_C51\multi-project\stm8_demo\lib\delay\stm8s_delay.c:5
                if (this.regexpList['stopLine'].test(line)) {
                    const match = this.regexpList['stopLine'].exec(line);
                    if (match && match.length > 2) {
                        result.data.bkpt['file'] = match[1];
                        result.data.bkpt['line'] = parseInt(match[2]);
                    }
                    return;
                }

                // 43          DelayInit();
                // 0x0086f5	56	    CLK_HSIPrescalerConfig(CLK_PRESCALER_HSIDIV1);
                if (this.regexpList['stopFunc'].test(line)) {
                    const match = this.regexpList['stopFunc'].exec(line);
                    if (match && match.length > 1) {
                        result.data.bkpt['line'] = parseInt(match[1]);
                    }
                }
                break;
            case this.gdb.addBreakPoint.name:
                // add breakpoint
                if (/^Breakpoint \d+ /.test(line)) {
                    const match = this.regexpList['breakpoint'].exec(line);
                    if (match && match.length > 3) {
                        result.data.bkpt['number'] = parseInt(match[1]);
                        result.data.bkpt['file'] = match[2];
                        result.data.bkpt['line'] = parseInt(match[3]);
                    }
                    return;
                }
                break;
            case this.gdb.getStack.name:
                // stack start with '#'
                if (line.startsWith('#')) {
                    /* 
                      #0  Setup () at c:\Users\admin_cl\Desktop\test\test_C51\multi-project\stm8_demo\src\main.c:19
                      #1  0x0086b2 in main () at c:\Users\admin_cl\Desktop\test\test_C51\multi-project\stm8_demo\src\main.c:46
                    */
                    if (this.regexpList['vaildStack'].test(line)) {
                        const match = this.regexpList['vaildStack'].exec(line);
                        if (match && match.length > 6) {

                            let addr: string | null = null;
                            const mList = this.regexpList['stackAddress'].exec(match[2].trim());
                            if (mList && mList.length > 1) {
                                addr = mList[1];
                            }

                            const _stack: Stack = {
                                level: parseInt(match[1]),
                                address: addr,
                                function: `${match[3]} ()`,
                                file: match[5],
                                fileName: path.basename(match[5]),
                                line: parseInt(match[6]),
                                paramsList: null
                            };

                            // parse func params values
                            const localVar = this.parseVariable(`__`, `{${match[4].trim()}}`);
                            if (Array.isArray(localVar.value) && localVar.value.length > 0) {
                                _stack.paramsList = localVar.value;
                            }

                            if (result.data.stack) {
                                result.data.stack.push(_stack);
                            } else {
                                result.data.stack = [_stack];
                            }
                        }
                        return;
                    }

                    // #2  0x008719 in .near_func.text_4 ()
                    if (this.regexpList['anonymousStack'].test(line)) {
                        const match = this.regexpList['anonymousStack'].exec(line);
                        if (match && match.length > 3) {

                            let addr: string | null = null;
                            const mList = this.regexpList['stackAddress'].exec(match[2].trim());
                            if (mList && mList.length > 1) {
                                addr = mList[1];
                            }

                            const _stack: Stack = {
                                level: parseInt(match[1]),
                                address: addr,
                                function: match[3],
                                file: null,
                                fileName: null,
                                paramsList: null,
                                line: null
                            };

                            if (result.data.stack) {
                                result.data.stack.push(_stack);
                            } else {
                                result.data.stack = [_stack];
                            }
                        }
                        return;
                    }
                }
                break;
            case this.gdb.getVariableValue.name:
            case this.gdb.getLocalVariables.name:
                // local variables
                // No locals.
                // clock = 16 '\020'
                // $1 = 16 '\020'
                // name = {next = 900, prev = 38399, arr = "\377\202\225\206r\a\373\205\237\205\255\004"}
                if (this.regexpList['expression'].test(line)) {
                    const match = this.regexpList['expression'].exec(line);
                    if (match && match.length > 2) {
                        const variable = this.parseVariable(match[1], match[2]);
                        if (result.data.var) {
                            result.data.var.push(variable);
                        } else {
                            result.data.var = [variable];
                        }
                    }
                    return;
                }
                break;
            case this.gdb.getGlobalVariables.name:

                // skip prase sdcc 'Non-debugging symbols':
                // Non-debugging symbols:
                // 0x0000801b  A$maint\Debug\main$76
                // 0x0000801e  A$maint\Debug\main$77
                if(line.startsWith('0x')) {
                    return;
                }

                // global variable define
                if (this.regexpList['varDefine'].test(line)) {
                    const match = this.regexpList['varDefine'].exec(line);
                    if (match && match.length > 1) {
                        if (result.data.varDef) {
                            result.data.varDef.push(<VariableDefine>{ name: match[1] });
                        } else {
                            result.data.varDef = [<VariableDefine>{ name: match[1] }];
                        }
                    }
                    return;
                }
                break;
            case this.gdb.getRegisterVariables.name:
                // register
                if (this.regexpList['register'].test(line)) {
                    const match = this.regexpList['register'].exec(line);
                    if (match && match.length > 2) {
                        const variable = <Variable>{
                            name: match[1],
                            type: 'integer',
                            value: match[2]
                        };
                        if (result.data.var) {
                            result.data.var.push(variable);
                        } else {
                            result.data.var = [variable];
                        }
                    }
                    return;
                }
                break;
            case this.gdb.readMemory.name:
                /**
                 * (gdb) x/16xb 0x0
                 * 0x0 <?w0>:	0x20	0x20	0xff	0x00	0xff	0x00	0xff	0x00
                 * 0x8 <?w4>:	0xff	0x00	0xff	0x00	0xff	0x00	0xff	0x00
                */
                if (this.regexpList['memValues'].test(line)) {
                    const match = this.regexpList['memValues'].exec(line);
                    if (match && match.length > 2) {

                        const vList: number[] = match[2]
                            .split(/\s+/)
                            .map((val) => { return parseInt(val); });

                        if (result.data.memory) {
                            result.data.memory.buf = result.data.memory.buf.concat(vList);
                        } else {
                            result.data.memory = {
                                addr: parseInt(match[1]),
                                buf: vList
                            };
                        }
                    }
                    return;
                }
                break;
            case this.gdb.readDisassembly.name:
                /**
                 * Dump of assembler code for function main:
                 * 0x008a58 <main+0>:	0x89	PUSHW X	PUSHW X
                 * 0x008b01 <main+169>:	0x2703	JREQ  0x8b06	JREQ  0x8b06
                 * End of assembler dump.
                */
                if (!line.startsWith('Dump') && !line.startsWith('End')) {
                    if (result.data.disassembly) {
                        result.data.disassembly.push(line);
                    } else {
                        result.data.disassembly = [line];
                    }
                }
                break;
            case this.gdb.sendCustomCommand.name:
                if (result.data.customLines) {
                    result.data.customLines.push(line);
                } else {
                    result.data.customLines = [line];
                }
                break;
            default:
                result.logs.push(line);
                break;
        }
    }

    // test: {a={a=0,c=90,d={a="{}"}},b=90}
    private splitObj(_str: string): string[] {

        const str = _str
            .replace(/^\s*\{/, '')
            .replace(/\}\s*$/, '');

        const resList: string[] = [];
        const stack: string[] = [];

        let iStart = 0;
        let inString = false;
        const endIndex = str.length - 1;

        for (let index = 0; index < str.length; index++) {
            const char = str[index];
            switch (char) {
                case '{':
                    if (!inString) {
                        stack.push(char);
                    }
                    break;
                case '}':
                    if (!inString) {
                        stack.pop();
                        if (stack.length === 0 && index === endIndex) {
                            resList.push(str.substring(iStart, index + 1));
                        }
                    }
                    break;
                case '\'':
                case '"':
                    if (index === 0 || str[index - 1] !== '\\') {
                        if (stack.length > 0 && stack[stack.length - 1] === char) {
                            inString = false;
                            stack.pop();
                            if (stack.length === 0 && index === endIndex) {
                                resList.push(str.substring(iStart, index + 1));
                            }
                        } else {
                            inString = true;
                            stack.push(char);
                        }
                    }
                    break;
                case ',':
                    if (stack.length === 0) {
                        resList.push(str.substring(iStart, index));
                        iStart = index + 1;
                    }
                    break;
                default:
                    if (stack.length === 0 && index === endIndex) {
                        resList.push(str.substring(iStart, index + 1));
                    }
                    break;
            }
        }

        return resList;
    }

    private parseVariable(name: string, val: string): Variable {

        const rootObj = this.parseUnit(name, val);
        if (rootObj.type !== 'obj') {
            return rootObj;
        }

        const variable: Variable = {
            name: name,
            type: 'obj',
            value: val
        };

        const extractVar = (str: string): { k: string, v: string } | undefined => {
            const match = this.regexpList['expression'].exec(str);
            if (match && match.length > 2) {
                return {
                    k: match[1],
                    v: match[2]
                };
            }
        };

        const parseList: Variable[] = [variable];

        while (parseList.length > 0) {

            const tVar = <Variable>parseList.pop();
            const varArr = this.splitObj(<string>tVar.value).map((item) => {
                return item.trim();
            });

            // init obj
            tVar.value = [];

            // parse
            varArr.forEach((strItem, index) => {

                const keyVal = extractVar(strItem);

                let retVar: Variable;
                if (keyVal) {
                    retVar = this.parseUnit(keyVal.k, keyVal.v);
                } else {
                    retVar = this.parseUnit(index.toString(), strItem);
                    tVar.type = 'array';
                }

                (<Variable[]>tVar.value).push(retVar);
                if (retVar.type === 'obj') {
                    parseList.push(retVar);
                }
            });
        }

        return variable;
    }

    // l\002\003a\\\a\v
    private parseCharArray(str: string): Variable[] {

        const res: Variable[] = [];
        let rIndex = 0;
        const numberMatcher = /^\d+$/;

        for (let index = 0; index < str.length; index++) {
            const _char = str[index];
            if (_char === '\\') {
                const numStr = str.substr(index + 1, 3);
                if (numberMatcher.test(numStr)) {
                    index += 3;
                    res.push({
                        name: (rIndex++).toString(),
                        type: 'integer',
                        value: parseInt(numStr).toString()
                    });
                } else {
                    index++;
                    res.push({
                        name: (rIndex++).toString(),
                        type: 'integer',
                        value: this.transChartable[str[index]].toString()
                    });
                }
            } else {
                res.push({
                    name: (rIndex++).toString(),
                    type: 'integer',
                    value: _char.charCodeAt(0).toString()
                });
            }
        }

        return res;
    }

    private parseUnit(name: string, val: string): Variable {

        // integer
        if (this.valueMatcher['integer'].test(val)) {
            return {
                name: name,
                type: 'integer',
                value: val
            };
        }

        // float
        if (this.valueMatcher['float'].test(val)) {
            return {
                name: name,
                type: 'float',
                value: val
            };
        }

        // repeat array
        // {0 <repeats 12 times>}
        if (this.valueMatcher['repeatedArray'].test(val)) {
            return {
                name: name,
                type: 'orignal',
                value: val.substring(1, val.length - 1)
            };
        }

        // "\000\009\a\b\002"
        if (this.valueMatcher['string'].test(val) && /\\\d{3}|\\[a-zA-Z]/.test(val)) {
            const str = val.substring(1, val.length - 1);
            const arr = this.parseCharArray(str);
            return {
                name: name,
                type: 'array',
                value: arr
            };
        }

        // string
        if (this.valueMatcher['string'].test(val)) {
            const realStr = val.substring(1, val.length - 1);
            return {
                name: name,
                type: 'string',
                value: realStr
            };
        }

        // obj
        if (this.valueMatcher['objectValue'].test(val)) {
            return {
                name: name,
                type: 'obj',
                value: val
            };
        }

        // original string
        return {
            name: name,
            type: 'orignal',
            value: val
        };
    }

    parse(funcName: string, lines: string[]): GdbResult {

        const result: GdbResult = {
            resultType: 'done',
            data: new ResultData(),
            error: null,
            logs: []
        };

        for (const line of lines) {
            this.parseLine(funcName, line.trimRight(), result);
        }

        return result;
    }
}


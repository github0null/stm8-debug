import { type } from "os";

export type GdbResultType = 'failed' | 'done';

/**
 * keyValue: 
 *          "bkpt": { "file": "", "line": "" }
 *          "var": [{"name": "", "value": ""}]
 *          "stack": [{}]
 *          "error": "msg"
*/

export class ResultData {
    public bkpt: Breakpoint = <any>{};
    public varDef: VariableDefine[] | null = null;
    public var: Variable[] | null = null;
    public stack: Stack[] | null = null;
    public memory: Memory | null = null;
    public disassembly: string[] | null = null;
    public customLines: string[] | null = null;
}

export interface GdbResult {
    resultType: GdbResultType;
    error: string | null;
    data: ResultData;
    logs: string[];
}

export interface Breakpoint {
    file: string | null;
    line: number;
    condition?: string;
    number?: number;
}

export interface Stack {
    level: number;
    function: string;
    address: string | null;
    fileName: string | null;
    file: string | null;
    line: number | null;
    paramsList: Variable[] | null;
}

export type ValueType = 'string' | 'integer' | 'float' | 'obj' | 'array' | 'orignal';

export type VariableChildren = Variable[];

export interface VariableDefine {
    name: string;
}

export interface Variable extends VariableDefine {
    type: ValueType;
    value: string | VariableChildren;
}

export type GdbServerType = 'st7' | 'stm8-sdcc';

export interface ConnectOption {

    executable: string;

    cpu: string;
    
    serverType: GdbServerType;
    
    interface?: string;
    
    openOcdConfigs?: string[];

    port?: string;
    
    customCommands?: string[];
}

export interface Memory {
    addr: number;
    buf: number[];
}

export interface CustomCommandResult {
    resultType: GdbResultType;
    lines: string[];
    error: string | null;
    logs: string[];
}

export type ErrorMsg = string;

export type LogType = 'warning' | 'log' | 'error' | 'hide';

export interface LogData {
    type: LogType;
    msg: string;
}

export interface GdbAdapter {

    // -- field

    type: GdbServerType;

    // -- method

    getExePath(): string;

    getConnectCommands(option: ConnectOption): string[];

    getDisconnectCommands(): string[];

    getStartDebugCommands(executable: string): string[];

    // -- event 

    onConnect(option: ConnectOption): Promise<ErrorMsg | undefined | void>;

    onKill(): Promise<ErrorMsg | undefined>;
}

export interface IGDB {

    /**
     * @note launch gdb.exe process
    */
    launch(args?: string[]): Promise<ErrorMsg | null>;

    /**
     * @note kill gdb.exe process
    */
    kill(): Promise<void>;

    on(event: 'log', lisenter: (data: LogData) => void): void;

    sendCommand(command: string, funcName: string, logType: LogType): Promise<GdbResult>;

    getCommandTimeUsage(): number | undefined;

    // -- launch commands --

    /**
     * @note connect target board by gdb
    */
    connect(option: ConnectOption): Promise<boolean>;

    /**
     * @note disconnect target board by gdb
    */
    disconnect(): Promise<void>;

    /**
     * @note start debug by **executable** file
    */
    startDebug(executable: string, otherCommand?: string[]): Promise<boolean>;

    /**
     * @note program is stopped
    */
    isStopped(): boolean;

    // -- gdb commands --

    interrupt(): Promise<Breakpoint>;

    continue(syncMode?: boolean): Promise<Breakpoint>;

    next(instruction?: boolean): Promise<Breakpoint>;

    step(instruction?: boolean): Promise<Breakpoint>;

    stepOut(): Promise<Breakpoint>;

    addBreakPoint(breakpoint: Breakpoint): Promise<Breakpoint>;

    removeBreakpoints(breakpoints: number[]): Promise<boolean>;

    getStack(startFrame: number, endFrame: number): Promise<Stack[]>;

    getLocalVariables(): Promise<Variable[]>;

    getVariableValue(name: string): Promise<Variable>;

    getGlobalVariables(): Promise<VariableDefine[]>;

    getRegisterVariables(): Promise<Variable[]>;

    readMemory(addr: number, len: number): Promise<Memory>;

    readDisassembly(params: string | { start: string, length: string }): Promise<string[]>;

    sendCustomCommand(command: string, showLog?: boolean): Promise<CustomCommandResult>;
}
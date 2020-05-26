
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
    public error: string | null = null;
    public memory: Memory | null = null;
}

export interface GdbResult {
    resultType: GdbResultType;
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

export interface ConnectOption {
    executable: string;
    interface: string;
    cpu: string;
    port?: string;
    customCommands?: string[];
}

export interface Memory {
    addr: number;
    buf: number[];
}

export type ErrorMsg = string;

export type LogType = 'warning' | 'log' | 'error' | 'hide';

export interface LogData {
    type: LogType;
    msg: string;
}

export interface IGDB {

    start(exe: string, args?: string[]): Promise<ErrorMsg | null>;

    kill(): Promise<void>;

    on(event: 'log', lisenter: (data: LogData) => void): void;

    sendCommand(command: string, funcName: string, logType: LogType): Promise<GdbResult>;

    //-- gdb commands --

    isStopped(): boolean;

    connect(option: ConnectOption, otherCommand?: string[]): Promise<boolean>;

    disconnect(): Promise<void>;

    interrupt(): Promise<Breakpoint>;

    continue(): Promise<Breakpoint>;

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
}
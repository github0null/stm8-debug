import * as process from 'child_process';
import * as events from 'events';
import * as ReadLine from 'readline';
import { EOL } from 'os';
import { Stream, Writable, Readable } from 'stream';

export type ExecutableOption = { encoding?: string | null } & process.ExecFileOptions
    | process.ForkOptions | process.ExecOptions;

export interface Executable {

    readonly stdin: Writable | undefined;

    readonly stdout: Readable | undefined;

    readonly stderr: Readable | undefined;

    Run(path_or_cmd: string, args?: string[], options?: ExecutableOption): void;

    Kill(): Promise<void>;

    IsExit(): boolean;

    signal(signal: NodeJS.Signals): void;

    pid(): number | undefined;

    on(event: 'launch', listener: (launchOk?: boolean) => void): this;

    on(event: 'close', listener: (exitInfo: ExitInfo) => void): this;

    on(event: 'error', listener: (err: Error) => void): this;
}

export interface ExitInfo {
    code: number;
    signal: string;
}

export abstract class Process implements Executable {

    static killSignal: NodeJS.Signals = 'SIGKILL';

    protected readonly codeType = 'utf8';

    protected _event: events.EventEmitter;
    protected proc: process.ChildProcess | null = null;
    protected launchTimeout: number;

    public stdin: Writable | undefined;
    public stdout: Readable | undefined;
    public stderr: Readable | undefined;

    private _exited: boolean;

    constructor(timeout?: number) {
        this.launchTimeout = timeout ? timeout : 50;
        this._event = new events.EventEmitter();
        this._exited = true;
    }

    on(event: 'launch', listener: () => void): this;
    on(event: 'close', listener: (exitInfo: ExitInfo) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: any, listener: (argc?: any) => void) {
        this._event.on(event, listener);
        return this;
    }
    
    signal(signal: NodeJS.Signals): void {
        if (this.proc === null) {
            throw new Error('process is not launched !');
        }
        this.proc.kill(signal);
    }

    Run(exePath: string, args?: string[] | undefined, options?: ExecutableOption | undefined): void {

        if (!this._exited) {
            throw new Error('process has not exited !');
        }

        this.proc = this.Execute(exePath, args, options);

        this._exited = false;

        if (this.proc.stdin) {
            this.stdin = this.proc.stdin;
        }

        if (this.proc.stdout) {
            this.proc.stdout.setEncoding((<any>options)?.encoding || this.codeType);
            this.stdout = this.proc.stdout;
        }

        if (this.proc.stderr) {
            this.proc.stderr.setEncoding((<any>options)?.encoding || this.codeType);
            this.stderr = this.proc.stderr;
        }

        this.proc.on('error', (err) => {
            this._event.emit('error', err);
        });

        this.proc.on('close', (code, signal) => {
            this._event.emit('close', <ExitInfo>{
                code: code,
                signal: signal
            });
            this._exited = true;
        });

        setTimeout((proc: process.ChildProcess) => {
            this._event.emit('launch', !proc.killed);
        }, this.launchTimeout, this.proc);
    }

    Kill(): Promise<void> {
        return new Promise((resolve) => {
            if (this.proc && !this.proc.killed) {
                this._event.once('close', (exitInfo: ExitInfo) => {
                    resolve();
                    if (exitInfo.signal !== Process.killSignal) {
                        this._event.emit('error', new Error('Process killed with error signal !'));
                    }
                });
                this.proc.kill(Process.killSignal);
            } else {
                resolve();
            }
        });
    }

    IsExit(): boolean {
        return this._exited;
    }
    
    pid(): number | undefined {
        return this.proc?.pid;
    }

    protected abstract Execute(exePath: string, args?: string[] | undefined, options?: ExecutableOption | undefined): process.ChildProcess;
}

export class ExeFile extends Process {

    protected Execute(exePath: string, args?: string[] | undefined, options?: ExecutableOption | undefined): process.ChildProcess {
        return process.execFile(exePath, args, options);
    }
}

export class ExeCmd extends Process {

    protected Execute(command: string, args?: string[] | undefined, options?: ExecutableOption | undefined): process.ChildProcess {
        if (args) {
            command += ' ' + args.join(' ');
        }
        return process.exec(command, <process.ExecOptions>options);
    }
}

export class ExeModule extends Process {

    protected Execute(exePath: string, args?: string[] | undefined, options?: ExecutableOption | undefined): process.ChildProcess {
        return process.fork(exePath, args, options);
    }
}
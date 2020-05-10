import * as process from 'child_process';
import * as events from 'events';
import * as ReadLine from 'readline';
import { EOL } from 'os';

export type ExecutableOption = { encoding?: string | null } & process.ExecFileOptions
    | process.ForkOptions | process.ExecOptions;

export interface Executable {

    Run(exePath: string, args?: string[], options?: ExecutableOption): void;

    Kill(): Promise<void>;

    IsExit(): boolean;

    write(chunk: any): Promise<Error | undefined | null>;

    remove(event: any, lisenter: any): void;

    signal(signal: NodeJS.Signals): void;

    on(event: 'data', listener: (data: string) => void): this;

    on(event: 'launch', listener: (launchOk?: boolean) => void): this;

    on(event: 'close', listener: (exitInfo: ExitInfo) => void): this;

    on(event: 'error', listener: (err: Error) => void): this;

    on(event: 'line', listener: (line: string) => void): this;

    on(event: 'errLine', listener: (line: string) => void): this;
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

    private _exited: boolean;

    constructor(timeout?: number) {
        this.launchTimeout = timeout ? timeout : 0;
        this._event = new events.EventEmitter();
        this._exited = true;
    }

    on(event: 'launch', listener: () => void): this;
    on(event: 'close', listener: (exitInfo: ExitInfo) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'data', listener: (data: string) => void): this;
    on(event: 'line', listener: (line: string) => void): this;
    on(event: 'errLine', listener: (line: string) => void): this;
    on(event: any, listener: (argc?: any) => void) {
        this._event.on(event, listener);
        return this;
    }

    remove(event: any, lisenter: any): void {
        this._event.removeListener(event, lisenter);
    }

    write(chunk: any): Promise<Error | undefined | null> {
        return new Promise((resolve) => {
            try {
                const process = <process.ChildProcess>this.proc;
                if (process.stdin) {
                    process.stdin.write(chunk, (err) => {
                        resolve(err);
                    });
                } else {
                    resolve(new Error('process \'stdin\' is null !'));
                }
            } catch (error) {
                resolve(error);
            }
        });
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

        if (this.proc.stdout) {

            this.proc.stdout.setEncoding((<any>options)?.encoding || this.codeType);
            this.proc.stdout.on('data', (data: string) => {
                this._event.emit('data', data);
            });

            // line
            const stdout = ReadLine.createInterface({ input: this.proc.stdout });
            stdout.on('line', (line) => {
                this._event.emit('line', line);
            });
        }

        if (this.proc.stderr) {

            this.proc.stderr.setEncoding((<any>options)?.encoding || this.codeType);
            this.proc.stderr.on('data', (data: string) => {
                this._event.emit('data', data);
            });

            // line
            const stderr = ReadLine.createInterface({ input: this.proc.stderr });
            stderr.on('line', (line) => {
                this._event.emit('errLine', line);
            });
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
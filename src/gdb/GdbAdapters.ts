import { ConnectOption, GdbAdapter, GdbServerType } from "./IGDB";
import { ResourceManager } from "../ResourceManager";
import { File } from "../../lib/node-utility/File";
import * as NodePath from 'path';
import { Executable, ExeFile } from "../../lib/node-utility/Executable";
import * as vscode from "vscode";
import * as child_process from 'child_process';

class GdbST7 implements GdbAdapter {

    type: GdbServerType = 'st7';

    async onConnect(option: ConnectOption): Promise<string | undefined> {

        // clear log
        const logFile = File.fromArray([NodePath.dirname(this.getExePath()), 'swim', 'Error.log']);
        if (logFile.IsFile()) {
            logFile.Write('');
        }

        return undefined;
    }

    async onKill(): Promise<string | undefined> {
        return undefined;
    }

    //---

    getExePath(): string {
        return ResourceManager.getInstance().getBinDir().path +
            File.sep + 'st7' +
            File.sep + 'gdb.exe';
    }

    getConnectCommands(option: ConnectOption): string[] {
        const portString = option.port ? `-port ${option.port}` : '';
        const interfaceStr = option.interface ? option.interface : 'stlink3';
        return [
            `set print elements 0`, // full print char array
            `set width 0`, // disable multi-line
            `file "${option.executable}"`,
            `target gdi -dll swim\\stm_swim.dll -${interfaceStr} ${portString}`,
            `mcuname -set ${option.cpu}`
        ];
    }

    getDisconnectCommands(): string[] {
        return [
            'delete',
            'symbol-file',
            'target gdi -close'
        ];
    }

    getStartDebugCommands(executable: string): string[] {
        return [
            `load`,
            `reset`
        ];
    }
}

class GdbSDCC implements GdbAdapter {

    type: GdbServerType = 'stm8-sdcc';

    private openOCDHost: Executable = <any>undefined;
    private output: vscode.OutputChannel;

    constructor() {
        this.output = vscode.window.createOutputChannel('openocd-stm8');
        this.output.clear();
    }

    onConnect(option: ConnectOption): Promise<string | undefined> {

        return new Promise((resolve) => {

            // openocd.exe -f interface/stlink.cfg -f target/stm8s.cfg -c "init" -c "reset halt"
            const exePath = ResourceManager.getInstance().getOpenOCDPath();
            const commands: string[] = [];

            // new instance
            this.openOCDHost = new ExeFile();
            this.output.clear();

            // check openOCD
            try {
                child_process.execFileSync(exePath, ['-v']);
            } catch (error) {
                vscode.window.showErrorMessage('Not found openocd !, Please set it !');
                resolve('Not found openocd !');
                return;
            }

            // fixed path
            option.executable = option.executable.replace(/\\+/g, '/');

            option.openOcdConfigs?.forEach((item) => {
                commands.push('-f', item);
            });

            commands.push('-c', 'init');
            commands.push('-c', 'reset halt');

            this.openOCDHost.on('launch', (launched) => {
                if (launched) {
                    resolve();
                } else {
                    resolve('launch Openocd failed !');
                }
            });

            this.openOCDHost.on('error', (err: Error) => {
                this.output.append(`[Error]: ${err.name}: ${err.message}\r\n${err.stack}`);
            });

            this.openOCDHost.on('close', (exitInfo) => {
                this.output.appendLine(`[Exited]: exit code ${exitInfo.code}`);
            });

            if (this.openOCDHost.stdout) {
                this.openOCDHost.stdout.on('data', (data: string) => {
                    this.output.append(data);
                });
            }

            if (this.openOCDHost.stderr) {
                this.openOCDHost.stderr.on('data', (data: string) => {
                    this.output.append(data);
                });
            }

            // log
            this.output.appendLine(`[Log]: launch openocd: ${exePath} ${commands.join(' ')}\r\n`);

            this.openOCDHost.Run(exePath, commands);
        });
    }

    async onKill(): Promise<string | undefined> {
        await this.openOCDHost.Kill();
        return undefined;
    }

    //---

    getExePath(): string {
        return ResourceManager.getInstance().getBinDir().path +
            File.sep + 'sdcc' +
            File.sep + 'stm8-gdb.exe';
    }

    getConnectCommands(option: ConnectOption): string[] {
        return [
            `set print elements 0`, // full print char array
            `set width 0`, // disable multi-line
            `file "${option.executable}"`,
            `target extended-remote localhost:3333`
        ];
    }

    getDisconnectCommands(): string[] {
        return [
            'delete',
            'symbol-file'
        ];
    }

    getStartDebugCommands(executable: string): string[] {
        return [
            `load`
        ];
    }
}

//---------------------------

const gdbAdapterList: GdbAdapter[] = [
    new GdbST7(),
    new GdbSDCC()
];

export function getAdapter(type: GdbServerType): GdbAdapter | undefined {
    const index = gdbAdapterList.findIndex((item) => { return item.type === type; });
    return gdbAdapterList[index];
}

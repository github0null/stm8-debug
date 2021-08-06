import * as vscode from 'vscode';
import * as net from 'net';
import { DebugAdapter } from './DebugAdapter';
import { ResourceManager } from './ResourceManager';
import * as os from 'os';
import { CodelensProvider } from './CodeLensProvider';
import { File } from '../lib/node-utility/File';
import * as utility from './utility';
import * as fs from 'fs';
import * as platform from './platform';

let vsContext: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext) {

    vsContext = context;

    console.log('---- stm8 debugger actived ----');

    if (os.platform() !== 'win32') {
        vscode.window.showErrorMessage('STM8 Debugger only for win32 platform !');
        return;
    }

    ResourceManager.getInstance(context);

    /* check stm8 gdb binaries */
    if (!await checkBinaries(context)) { 
        vscode.window.showErrorMessage(`Install stm8 gdb failed, aborted !`);
        return; 
    }

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('stm8-debug', new STM8DebugAdapterDescriptorFactory()),
        vscode.debug.registerDebugConfigurationProvider('stm8-debug', new STM8ConfigurationProvider()),
        vscode.languages.registerCodeLensProvider({ language: 'c' }, new CodelensProvider())
    );
}

export function deactivate() {
    console.log('---- stm8 debugger closed ----');
}

class STM8ConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
    resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {

        if (config.type !== 'stm8-debug') {
            return;
        }

        // if launch.json is missing or empty
        if (!folder) {
            return vscode.window.showWarningMessage("Workspace not found").then(_ => {
                return undefined;	// abort launch
            });
        }

        return config;
    }
}

class STM8DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

    private server?: net.Server;

    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

        this.dispose();

        this.server = net.createServer(socket => {
            const session = new DebugAdapter();
            vsContext.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
                ResourceManager.getInstance().getAppName(), session)); // disassembly provider
            session.setRunAsServer(true);
            session.start(<NodeJS.ReadableStream>socket, socket);
        }).listen(55555);

        // make VS Code connect to debug server
        return new vscode.DebugAdapterServer((<net.AddressInfo>this.server.address()).port);
    }

    dispose() {
        if (this.server) {
            this.server.close();
            this.server = undefined;
        }
    }
}

async function checkBinaries(constex: vscode.ExtensionContext): Promise<boolean> {

    const downloadSites: string[] = [
        `https://raw-github.github0null.io/github0null/stm8-debug/master/bin/gdb.7z`,
        `https://raw.githubusercontent.com/github0null/stm8-debug/master/bin/gdb.7z`
    ];

    const rootFolder = new File(constex.extensionPath);
    const binFolder = File.fromArray([rootFolder.path, 'bin']);

    /* check bin folder */
    if (File.fromArray([binFolder.path, File.ToLocalPath('st7/gdb.exe')]).IsFile()) {
        return true; /* found it, exit */
    }

    let installedDone = false;

    try {
        const tmpFile = File.fromArray([os.tmpdir(), 'stm8-gdb-bin.7z']);

        /* make dir */
        binFolder.CreateDir(true);

        const done = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading stm8 gdb binaries',
            cancellable: false
        }, async (progress, token): Promise<boolean> => {

            let res: Buffer | undefined | Error = undefined;

            for (const site of downloadSites) {
                const realUrl = utility.redirectHost(site);
                res = await utility.downloadFileWithProgress(realUrl, tmpFile.name, progress, token);
                if (res instanceof Buffer) { break; } /* if done, exit loop */
                progress.report({ message: 'Switch to next download site !' });
            }

            if (res instanceof Error) { /* download failed */
                vscode.window.showWarningMessage(`Error: ${res.message}`);
                return false;
            } else if (res == undefined) { /* canceled */
                return false;
            }

            /* save to file */
            fs.writeFileSync(tmpFile.path, res);

            return true;
        });

        /* download done, unzip and install it */
        if (done) {

            installedDone = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Installing stm8 gdb binaries`,
                cancellable: false
            }, async (progress, __): Promise<boolean> => {

                return new Promise((resolve_) => {

                    let resolved = false;
                    const resolveIf = (data: boolean) => {
                        if (!resolved) {
                            resolved = true;
                            resolve_(data);
                        }
                    };
                    
                    progress.report({ message: `Unzipping package ...` });

                    const err = platform.unzipSync(
                        ResourceManager.getInstance().get7zaExe().path,
                        tmpFile,
                        binFolder
                    );

                    if (err) {
                        vscode.window.showErrorMessage(`Error: ${err.message}`);
                        resolveIf(false);
                        return;
                    }

                    progress.report({ message: `Install stm8 gdb binaries done !` });
                    setTimeout(() => resolveIf(true), 500);
                });
            });
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Error: ${error.message}`);
    }

    /* clear dir if failed */
    if (!installedDone) {
        platform.DeleteDir(File.fromArray([binFolder.path, 'sdcc']));
        platform.DeleteDir(File.fromArray([binFolder.path, 'st7']));
        platform.DeleteDir(File.fromArray([binFolder.path, 'openocd']));
    }

    return installedDone;
}

import * as vscode from 'vscode';
import * as net from 'net';
import { DebugAdapter } from './DebugAdapter';
import { ResourceManager } from './ResourceManager';
import * as os from 'os';
import { CodelensProvider } from './CodeLensProvider';

let vsContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {

    vsContext = context;

    console.log('---- stm8 debugger actived ----');

    if (os.platform() !== 'win32') {
        vscode.window.showErrorMessage('STM8 Debugger only for win32 platform !');
        return;
    }

    ResourceManager.getInstance(context);

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


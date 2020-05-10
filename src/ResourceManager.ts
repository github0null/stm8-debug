import * as vscode from 'vscode';
import { File } from '../lib/node-utility/File';

let _instance: ResourceManager | undefined;

const dirList: string[] = [
    File.sep + 'bin'
];

export class ResourceManager {

    private extensionDir: File;
    private dirMap: Map<string, File>;
    private workspaceDir: File | null;

    private constructor(context: vscode.ExtensionContext) {
        this.extensionDir = new File(context.extensionPath);
        this.dirMap = new Map();
        this.workspaceDir = null;
        this.init();
    }

    static getInstance(context?: vscode.ExtensionContext): ResourceManager {
        if (_instance === undefined) {
            if (context) {
                _instance = new ResourceManager(context);
            } else {
                throw Error('context can\'t be undefined');
            }
        }
        return _instance;
    }

    getBinDir(): File {
        return <File>this.dirMap.get('bin');
    }

    getWorkspaceDir(): File | null {
        return this.workspaceDir;
    }

    isVerboseMode(): boolean {
        return this.getAppConfig().get<boolean>('UseVerboseMode') || false;
    }

    //---

    private init() {

        const wsFolder = vscode.workspace.workspaceFolders;
        if (wsFolder && wsFolder.length > 0) {
            this.workspaceDir = new File(wsFolder[0].uri.fsPath);
        }

        // init dirs
        for (const path of dirList) {
            const f = new File(this.extensionDir.path + path);
            if (f.IsDir()) {
                this.dirMap.set(f.noSuffixName, f);
            }
        }
    }

    private getAppConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('stm8-debug');
    }
}

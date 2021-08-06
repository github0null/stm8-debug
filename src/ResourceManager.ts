import * as vscode from 'vscode';
import { File } from '../lib/node-utility/File';

let _instance: ResourceManager | undefined;

const dirList: string[] = [
    `${File.sep}bin`,
    `${File.sep}data${File.sep}svd`
];

export class ResourceManager {
    
    private readonly appName: string = 'stm8-debug';

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

    getAppName(): string {
        return this.appName;
    }

    getBinDir(): File {
        return <File>this.dirMap.get('bin');
    }

    getSvdDir(): File {
        return <File>this.dirMap.get('svd');
    }

    get7zaExe(): File {
        return File.fromArray([(<File>this.dirMap.get('bin')).path, '7z', '7za']);
    }

    getWorkspaceDir(): File | null {
        return this.workspaceDir;
    }

    getOpenOCDPath(): string {
        return this.getAppConfig().get<string>('OpenOcdPath') || 'openocd';
    }

    isVerboseMode(): boolean {
        return this.getAppConfig().get<boolean>('UseVerboseMode') || false;
    }

    isParseString2Array(): boolean {
        return this.getAppConfig().get<boolean>('ParseStringToArray') || false;
    }

    isDisplayTimeUsage(): boolean {
        return this.getAppConfig().get<boolean>('DisplayTimeUsage') || false;
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
                this.dirMap.set(f.name, f);
            }
        }
    }

    private getAppConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('stm8-debug');
    }
}

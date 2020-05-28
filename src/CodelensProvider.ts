import * as vscode from 'vscode';
import { GlobalEvent } from './GlobalEvent';
import { ResourceManager } from './ResourceManager';

export interface StoppedInfo {
    file: string;
    line: number;
    useTimeMs: number;
}

export class CodelensProvider implements vscode.CodeLensProvider {

    private _event: vscode.EventEmitter<void> = new vscode.EventEmitter();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._event.event;
    private currentInfo?: StoppedInfo;
    private enabled: boolean; // enable or disable time usage display

    constructor() {

        this.enabled = ResourceManager.getInstance().isDisplayTimeUsage();
        
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('stm8-debug.DisplayTimeUsage')) {
                this.enabled = ResourceManager.getInstance().isDisplayTimeUsage();
            }
        });

        GlobalEvent.on('debug.onStopped', (info) => {
            this.currentInfo = info;
            this._event.fire();
        });

        GlobalEvent.on('debug.terminal', () => {
            this.currentInfo = undefined;
            this._event.fire();
        });
    }

    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        if (this.enabled && this.currentInfo &&
            document.uri.fsPath === this.currentInfo.file) {
            const line = document.lineAt(this.currentInfo.line);
            return [
                new vscode.CodeLens(new vscode.Range(line.range.start, line.range.start))
            ];
        }
    }

    resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens> {
        if (this.enabled && this.currentInfo) {
            codeLens.command = {
                title: `about ${this.currentInfo.useTimeMs.toFixed(3)} ms`,
                command: ''
            };
            return codeLens;
        }
    }
}

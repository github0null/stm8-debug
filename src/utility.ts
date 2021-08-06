import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import { NetRequest } from '../lib/node-utility/NetRequest';
import { File } from '../lib/node-utility/File';

export function copyObject(src: any): any {
    if (typeof src === 'object') {
        return JSON.parse(JSON.stringify(src));
    } else {
        return src;
    }
}

export function md5(str: string): string {
    const md5 = crypto.createHash('md5');
    md5.update(str);
    return md5.digest('hex');
}

export function sha256(str: string): string {
    const md5 = crypto.createHash('sha256');
    md5.update(str);
    return md5.digest('hex');
}

export function sha1(str: string): string {
    const md5 = crypto.createHash('sha1');
    md5.update(str);
    return md5.digest('hex');
}

export function openUrl(url: string): Promise<Error | undefined> {
    return new Promise((resolve) => {
        child_process.execFile('explorer', [url], (err, stdout, stderr) => {
            if (err) { resolve(err); }
            else if (stderr) { resolve(new Error(`explorer "${url}" \r\n ${stderr}`)); }
            resolve(undefined);
        });
    });
}

export const toolsUrlMap = {
    "jlink": "https://www.segger.com/downloads/jlink/JLink_Windows_V650.exe",
    "sdcc": "https://sourceforge.net/projects/sdcc/files/latest/download",
    "stlink-utility": "https://www.st.com/zh/development-tools/stsw-link004.html",
    "stvp": "https://www.st.com/zh/development-tools/stvp-stm8.html",
    "arm-gcc": "https://developer.arm.com/tools-and-software/open-source-software/developer-tools/gnu-toolchain/gnu-rm/downloads"
};

const hostMap: any = {
    'api.github.com': 'api-github.em-ide.com',
    'raw.githubusercontent.com': 'raw-github.em-ide.com'
};

export function redirectHost(url: string) {
    for (const host in hostMap) { url = url.replace(host, hostMap[host]); }
    return url;
}

export function formatPath(path: string): string {
    return File.ToLocalPath(path.trim().replace(/(?:\\|\/)+$/, ''));
}

export async function downloadFile(url: string): Promise<Buffer | Error | undefined> {

    return new Promise(async (resolve) => {

        let locked = false;
        const resolveIf = (data: Error | Buffer | undefined) => {
            if (!locked) {
                locked = true;
                resolve(data);
            }
        };

        const netReq = new NetRequest();

        netReq.on('error', (err) => {
            resolveIf(err);
        });

        // parse path
        const urlParts = url.replace('https://', '').split('/');
        const hostName = urlParts[0];
        const path = '/' + urlParts.slice(1).join('/');

        const res = await netReq.RequestBinary<any>({
            host: hostName,
            path: path,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, 'https');

        let result: Buffer | Error | undefined;

        if (res.success && res.content) { // received ok
            result = res.content;
        } else {
            result = new Error(`Download file failed !, https errCode: ${res.statusCode}, msg: ${res.msg}`);
        }

        resolveIf(result);
    });
}

export async function downloadFileWithProgress(url: string, fileLable: string, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken): Promise<Buffer | Error | undefined> {

    return new Promise(async (resolve) => {

        let locked = false;
        const resolveIf = (data: Error | Buffer | undefined) => {
            if (!locked) {
                locked = true;
                resolve(data);
            }
        };

        const netReq = new NetRequest();

        netReq.on('error', (err) => {
            resolveIf(err);
        });

        token.onCancellationRequested(() => {
            netReq.emit('abort');
            resolveIf(undefined);
        });

        // parse path
        const urlParts = url.replace('https://', '').split('/');
        const hostName = urlParts[0];
        const path = '/' + urlParts.slice(1).join('/');

        let curIncrement: number = 0;

        const res = await netReq.RequestBinary<any>({
            host: hostName,
            path: path,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, 'https', (increment) => {
            curIncrement += increment;
            if (curIncrement > 1) { curIncrement = 1; } // limit to 100 %
            progress.report({
                increment: increment * 100,
                message: `${(curIncrement * 100).toFixed(1)}% of '${fileLable}'`
            });
        });

        let result: Buffer | Error | undefined;

        if (res.success && res.content) { // received ok
            result = res.content;
        } else if (token.isCancellationRequested === false) {
            result = new Error(`Download file failed !, https errCode: ${res.statusCode}, msg: ${res.msg}`);
        }

        resolveIf(result);
    });
}

export async function getDownloadUrlFromGit(repo: string, folder: string, fileName: string): Promise<any | Error | undefined> {

    return new Promise(async (resolve) => {

        const req = new NetRequest();

        const res = await req.Request<any, any>({
            host: `git.github0null.io`,
            path: `/api/v1/repos/root/${repo}/contents/${folder}`,
            timeout: 3000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, 'https');

        if (res.success == false || res.content == undefined) {
            resolve(new Error(res.msg || `can't connect to git repo !`));
            return;
        }

        let fInfo: any | undefined;

        for (const fileInfo of res.content) {
            if (fileInfo['name'] == fileName) {
                fInfo = fileInfo;
                break;
            }
        }

        resolve(fInfo);
    });
}

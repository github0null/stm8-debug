import * as child_process from 'child_process';
import * as os from 'os';
import { File } from '../lib/node-utility/File';

/**
 * kill process
*/
export function kill(pid: number): Error | undefined {
    try {
        if (os.platform() == 'win32') {
            child_process.execSync(`taskkill /PID ${pid} /T /F`);
        } else {
            child_process.execSync(`kill -9 ${pid}`);
        }
    } catch (error) {
        return error;
    }
}

/**
 * unzip
*/
export function unzipSync(_7za_path: string, zipFile: File, outFolder: File): Error | undefined {
    try {
        child_process.execSync(`${_7za_path} x -y -r -aoa "${zipFile.path}" "-o${outFolder.path}"`);
    } catch (error) {
        return error
    }
}

export function DeleteDir(dir: File): string {
    try {
        return child_process.execSync(`rmdir /S /Q "${dir.path}"`, { encoding: 'ascii' });
    } catch (error) {
        return JSON.stringify(error);
    }
}

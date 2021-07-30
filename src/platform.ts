import * as child_process from 'child_process';

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

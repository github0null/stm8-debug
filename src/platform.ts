import * as child_process from 'child_process';

/**
 * kill windows process
*/
export function kill(pid: number): Error | undefined {
    try {
        child_process.execSync(`taskkill /PID ${pid} /F`);
    } catch (error) {
        return error;
    }
}

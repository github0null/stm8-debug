import { EventEmitter } from 'events';
import { StoppedInfo } from './CodeLensProvider';

let instance: GlobalEvent | undefined;

export class GlobalEvent {

    private _event: EventEmitter;

    private constructor() {
        this._event = new EventEmitter();
    }

    private static getInstance(): GlobalEvent {
        if (instance === undefined) {
            instance = new GlobalEvent();
        }
        return instance;
    }

    //-----

    static emit(event: 'debug.onStopped', info: StoppedInfo): void;
    static emit(event: 'debug.terminal'): void;

    static emit(event: string, arg?: any): boolean {
        return this.getInstance()._event.emit(event, arg);
    }

    //-----
    
    static on(event: 'debug.onStopped', listener: (info: StoppedInfo) => void): void;
    static on(event: 'debug.terminal', listener: () => void): void;

    static on(event: string, listener: (arg: any) => void): void {
        this.getInstance()._event.on(event, listener);
    }
}

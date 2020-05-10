import * as http from 'http';
import * as events from 'events';
import * as https from 'https';

export type HttpRequestType = 'http' | 'https';

export interface RequestOption<T> extends http.RequestOptions {
    content?: T;
}

export interface NetResponse<T> {
    success: boolean;
    statusCode?: number;
    content?: T;
    msg?: string;
    location?: string;
}

export class NetRequest {

    private _event: events.EventEmitter;

    constructor() {
        this._event = new events.EventEmitter();
    }

    emit(event: 'abort'): boolean;
    emit(event: any, arg?: any): boolean {
        return this._event.emit(event, arg);
    }

    on(event: 'error', listener: (err: Error) => void): this;
    on(event: any, listener: (argc?: any) => void): this {
        this._event.on(event, listener);
        return this;
    }

    Request<T, ResponseType>(option: RequestOption<T> | string, type?: HttpRequestType,
        report?: (receivedSize: number) => void): Promise<NetResponse<ResponseType>> {

        return new Promise((resolve) => {

            if (typeof option !== 'string' && option.content) {
                option.method = 'GET';
            }

            let resolved: boolean = false;
            const resolveIf = (res?: NetResponse<ResponseType>) => {
                if (!resolved) {
                    resolved = true;
                    resolve(res);
                }
            };

            const callbk: (res: http.IncomingMessage) => void = (res) => {

                let data: string = '';
                res.setEncoding('utf8');

                this._event.on('abort', () => {
                    if (!res.destroyed) {
                        res.destroy();
                    }
                });

                res.on('error', (err) => {
                    this._event.emit('error', err);
                });

                res.on('close', () => {

                    if (res.statusCode && res.statusCode < 300) {

                        let content: ResponseType | undefined;
                        try {
                            content = JSON.parse(data);
                            resolveIf({
                                success: true,
                                statusCode: res.statusCode,
                                content: content,
                                msg: res.statusMessage
                            });
                        } catch (err) {
                            resolveIf({
                                success: false,
                                statusCode: res.statusCode,
                                msg: res.statusMessage
                            });
                        }
                    } else {
                        resolveIf({
                            success: false,
                            statusCode: res.statusCode,
                            msg: res.statusMessage
                        });
                    }
                });

                res.on('data', (buf) => {
                    data += buf;
                    if (report) {
                        report(data.length);
                    }
                });
            };

            try {

                let request: http.ClientRequest;

                if (type !== 'https') {
                    request = http.request(option, callbk);
                } else {
                    request = https.request(option, callbk);
                }

                this._event.on('abort', () => {
                    if (!request.destroyed) {
                        request.destroy();
                    }
                });

                request.on('error', (err) => {
                    resolveIf({
                        success: false
                    });
                    this._event.emit('error', err);
                });

                if (typeof option !== 'string' && option.content) {
                    request.end(JSON.stringify(option.content));
                } else {
                    request.end();
                }
            } catch (error) {
                resolveIf({
                    success: false
                });
                this._event.emit('error', error);
            }
        });
    }

    RequestBinary<T>(option: RequestOption<T> | string, type?: HttpRequestType, report?: (incrementSize: number) => void): Promise<NetResponse<Buffer>> {

        return new Promise((resolve) => {

            let buffer: Buffer = Buffer.from([]);
            let isAbort = false;

            if (typeof option !== 'string' && option.content) {
                option.method = 'GET';
            }

            let resolved: boolean = false;
            const resolveIf = (res: NetResponse<Buffer>) => {
                if (!resolved) {
                    resolved = true;
                    resolve(res);
                }
            };

            const callbk: (res: http.IncomingMessage) => void = (res) => {

                res.on('error', (err) => {
                    this._event.emit('error', err);
                });

                this._event.on('abort', () => {
                    if (!res.destroyed) {
                        isAbort = true;
                        res.destroy();
                    }
                });

                res.on('close', () => {
                    if (res.statusCode && res.statusCode < 300 && !isAbort) {
                        resolveIf({
                            success: true,
                            statusCode: res.statusCode,
                            msg: res.statusMessage,
                            content: buffer
                        });
                    } else {
                        resolveIf({
                            success: !isAbort,
                            statusCode: res.statusCode,
                            msg: res.statusMessage
                        });
                    }
                });

                res.on('data', (buf: Buffer) => {
                    buffer = Buffer.concat([buffer, buf], buffer.length + buf.length);
                    if (report) {
                        report(buffer.length);
                    }
                });
            };

            let request: http.ClientRequest;

            try {
                if (type !== 'https') {
                    request = http.request(option, callbk);
                } else {
                    request = https.request(option, callbk);
                }

                this._event.on('abort', () => {
                    if (!request.destroyed) {
                        isAbort = true;
                        request.destroy();
                    }
                });

                request.on('error', (err) => {
                    this._event.emit('error', err);
                    resolveIf({
                        success: false
                    });
                });

                if (typeof option !== 'string' && option.content) {
                    request.end(JSON.stringify(option.content));
                } else {
                    request.end();
                }

            } catch (error) {
                this._event.emit('error', error);
                resolveIf({
                    success: false
                });
            }
        });
    }
}
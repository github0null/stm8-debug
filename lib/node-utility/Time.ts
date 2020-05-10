let instance: Time;

//Format Example: 2019/9/22|10:12:23|GMT...

export interface TimeInfo {
    year: number;
    month: number;
    date: number;

    hour: number;
    minute: number;
    second: number;

    region: string;
}

export enum TimeFieldType {
    YEAR,
    MONTH,
    DATE,
    HOUR,
    MINUTE,
    SECOND,
    REGION
}

export class TimeData {

    private time: TimeInfo;

    constructor(timeInfo: TimeInfo) {
        this.time = timeInfo;
    }

    GetTimeInfo(): TimeInfo {
        return this.time;
    }

    Increase(fieldType: TimeFieldType, number: number) {

        if (!Number.isInteger(number)) {
            throw new Error('The increase number of time must be integer');
        }

        switch (fieldType) {
            case TimeFieldType.YEAR:
                this.time.year += number;
                break;
            case TimeFieldType.MONTH:
                this.IncreaseMonth(number);
                break;
            case TimeFieldType.DATE:
                this.IncreaseDate(number);
                break;
            case TimeFieldType.HOUR:
                this.IncreaseHour(number);
                break;
            case TimeFieldType.MINUTE:
                this.IncreaseMinute(number);
                break;
            case TimeFieldType.SECOND:
                this.IncreaseSecond(number);
                break;
            default:
                break;
        }
    }

    Compare(timeInfo: TimeInfo): number {

        let current = this.GetTimeInfo();

        if (current.year !== timeInfo.year) {
            return current.year - timeInfo.year;
        }

        if (current.month !== timeInfo.month) {
            return current.month - timeInfo.month;
        }

        if (current.date !== timeInfo.date) {
            return current.date - timeInfo.date;
        }

        if (current.hour !== timeInfo.hour) {
            return current.hour - timeInfo.hour;
        }

        if (current.minute !== timeInfo.minute) {
            return current.minute - timeInfo.minute;
        }

        if (current.second !== timeInfo.second) {
            return current.second - timeInfo.second;
        }

        return 0;
    }

    private IncreaseMonth(number: number) {

        this.time.month += number;

        if (this.time.month > 12) {

            this.time.year += parseInt((this.time.month / 12).toString());
            this.time.month = this.time.month % 12;

        } else if (this.time.month < 1) {

            this.time.year += parseInt((this.time.month / 12).toString()) - 1;
            this.time.month = 12 + (this.time.month % 12);
        }
    }

    private IncreaseDate(number: number) {
        if (number >= 0) {
            for (let i = 0; i < number; i++) {
                this.AddDate();
            }
        } else {
            for (let i = 0; i < -number; i++) {
                this.ReduceDate();
            }
        }
    }

    private IncreaseHour(number: number) {

        this.time.hour += number;

        if (this.time.hour > 23) {

            this.IncreaseDate(parseInt((this.time.hour / 24).toString()));
            this.time.hour = this.time.hour % 24;

        } else if (this.time.hour < 0) {

            this.IncreaseDate(parseInt((this.time.hour / 24).toString()) - 1);
            this.time.hour = 23 + (this.time.hour % 24);

        }
    }

    private IncreaseMinute(number: number) {

        this.time.minute += number;

        if (this.time.minute > 59) {

            this.IncreaseHour(parseInt((this.time.minute / 60).toString()));
            this.time.minute = this.time.minute % 60;

        } else if (this.time.minute < 0) {

            this.IncreaseHour(parseInt((this.time.minute / 60).toString()) - 1);
            this.time.minute = 59 + (this.time.minute % 60);

        }
    }

    private IncreaseSecond(number: number) {

        this.time.second += number;

        if (this.time.second > 59) {

            this.IncreaseMinute(parseInt((this.time.second / 60).toString()));
            this.time.second = this.time.second % 60;

        } else if (this.time.second < 0) {

            this.IncreaseMinute(parseInt((this.time.second / 60).toString()) - 1);
            this.time.second = 59 + (this.time.second % 60);

        }
    }

    private AddDate() {
        if (this.GetDateOfMonth() === this.time.date) {
            this.time.date = 1;
            this.IncreaseMonth(1);
        } else {
            this.time.date++;
        }
    }

    private ReduceDate() {
        if (this.time.date === 1) {
            this.IncreaseMonth(-1);
            this.time.date = this.GetDateOfMonth();
        } else {
            this.time.date--;
        }
    }

    private GetDateOfYear(): number {
        return this.time.year % 4 === 0 ? 366 : 365;
    }

    private GetDateOfMonth(): number {
        switch (this.time.month) {
            case 4:
            case 6:
            case 9:
            case 11:
                return 30;
            case 2:
                return this.GetDateOfYear() === 366 ? 29 : 28;
            default:
                return 31;
        }
    }
}

export class Time {

    private date: Date;
    private Separater: string;

    private constructor() {
        this.date = new Date();
        this.Separater = '|';
    }

    static GetInstance(): Time {
        if (instance) {
            return instance;
        }
        instance = new Time();
        return instance;
    }

    GetTimeStamp(): string {
        this.date.setTime(Date.now());
        let dateStr = this.GetDateString();
        let tList = this.date.toTimeString().split(' ');
        dateStr += this.Separater + tList[0] + this.Separater + tList[1];
        return dateStr;
    }

    private GetDateString(): string {
        return this.date.getFullYear().toString() + '/' + (this.date.getMonth() + 1).toString() + '/' + this.date.getDate().toString();
    }

    GetTimeInfo(): TimeInfo {

        this.date.setTime(Date.now());

        return {
            year: this.date.getFullYear(),
            month: this.date.getMonth(),
            date: this.date.getDate(),

            hour: this.date.getHours(),
            minute: this.date.getMinutes(),
            second: this.date.getSeconds(),

            region: this.date.toTimeString().split(' ')[1]
        };
    }

    Parse(timeStamp: string): TimeInfo {

        let fieldList = timeStamp.split('|');
        let yearField = fieldList[0].split('/');
        let timeField = fieldList[1].split(':');

        return {
            year: Number.parseInt(yearField[0]),
            month: Number.parseInt(yearField[1]),
            date: Number.parseInt(yearField[2]),

            hour: Number.parseInt(timeField[0]),
            minute: Number.parseInt(timeField[1]),
            second: Number.parseInt(timeField[2]),

            region: fieldList[2]
        };
    }

    Stringify(timeData: TimeInfo): string {
        return timeData.year.toString() + '/' + timeData.month.toString() + '/' + timeData.date.toString() + '|'
            + timeData.hour.toString() + ':' + timeData.minute.toString() + ':' + timeData.second.toString() + '|'
            + timeData.region;
    }

    SetTimeSeparater(sep: string) {
        this.Separater = sep;
    }

    GetTimeSeparater(): string {
        return this.Separater;
    }
}
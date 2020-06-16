# STM8 Debugger

## Summary 📑

A STM8 Debugger for vscode. Use GDB to debug your STM8 program

**Only for Windows platform**

***

![preview](./image/show.png)

***

## Usage 📖

### Preparatory work

1. Install STLink or RLink driver program

***

### Start 🏃‍♀️

1. Fill in `launch.json`, like: this

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "stm8-debug",
            "request": "launch",
            "name": "Launch Program",
            "executable": ".\\out\\IAR_STM8\\stm8_demo.out",
            "cpu": "STM8S105K4",
            "interface": "stlink3"
        }
    ]
}
```

2. connect target board, press `F5` to launch stm8 debugger

***

## Other support

### built-in peripheral support

- stm8s103f3
- stm8s003f3
- stm8s105k4

### custom peripheral support

**You can create a new \<CPU name>.svd.json to support a new stm8 cpu.**

1. create a new `<CPU name>.svd.json` file, write peripheral descriptions.

2. set `svdFile` property in `launch.json`

***

There is a demo for `stm8s003f3` cpu, file name: `stm8s003f3.svd.json`

```json
[
    {
        "name": "GPIOA",
        "baseAddress": "0x5000",
        "registers": [
            {
                "name": "ODR",
                "bytes": 1,
                "fields": [
                    {
                        "name": "0",
                        "bitsOffset": 0,
                        "bitsWidth": 1
                    }
                ]
            },
            {
                "name": "IDR",
                "bytes": 1
            },
            {
                "name": "DDR",
                "bytes": 1
            },
            {
                "name": "CR1",
                "bytes": 1
            },
            {
                "name": "CR2",
                "bytes": 1
            }
        ]
    },
    {
        "name": "FLASH",
        "baseAddress": "0x505A",
        "registers": [
            {
                "name": "CR1",
                "bytes": 1
            },
            {
                "name": "CR2",
                "bytes": 1
            },
            {
                "name": "NCR2",
                "bytes": 1
            },
            {
                "name": "FPR",
                "bytes": 1
            },
            {
                "name": "NFPR",
                "bytes": 1
            },
            {
                "name": "IAPSR",
                "bytes": 1
            },
            {
                "name": "PUKR",
                "baseAddress": "0x5062",
                "bytes": 1
            },
            {
                "name": "DUKR",
                "baseAddress": "0x5064",
                "bytes": 1
            }
        ]
    }
]
```

## Attention 🚩

- ### The file path must contain only ASCII characters

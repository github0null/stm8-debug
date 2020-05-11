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

2. press `F5` to launch stm8 debugger

## Attention 🚩

- **The file path must contain only ASCII characters**


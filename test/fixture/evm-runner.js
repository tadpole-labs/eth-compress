const { createVM } = require('@ethereumjs/vm');
const { Common, Mainnet } = require('@ethereumjs/common');
const { Address, Account } = require('@ethereumjs/util');
const { hexToBytes } = require('../utils.js');

function uint8ArrayToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function runEvmBytecode(bytecode, calldata, options = {}) {
  const common = new Common({ chain: Mainnet });
  const vm = await createVM({ common });

  const codeBytes = hexToBytes(bytecode);
  const dataBytes = hexToBytes(calldata);

  if (options.state) {
    for (const [addressHex, accountData] of Object.entries(options.state)) {
      const address = new Address(hexToBytes(addressHex));
      let account = await vm.stateManager.getAccount(address);

      if (!account) account = new Account();
      if (accountData.balance !== undefined) account.balance = BigInt(accountData.balance);
      await vm.stateManager.putAccount(address, account);

      if (accountData.code) await vm.stateManager.putCode(address, hexToBytes(accountData.code));
    }
  }

  let result;
  if (options.contractAddress && options.callerAddress) {
    const contractAddr = new Address(hexToBytes(options.contractAddress));
    const callerAddr = new Address(hexToBytes(options.callerAddress));

    await vm.stateManager.putCode(contractAddr, codeBytes);

    result = await vm.evm.runCall({
      to: contractAddr,
      caller: callerAddr,
      origin: callerAddr,
      data: dataBytes,
      gasLimit: BigInt(options.gasLimit || 10_000_000),
      value: BigInt(options.value || 0),
    });
  } else {
    result = await vm.evm.runCode({
      code: codeBytes,
      data: dataBytes,
      gasLimit: BigInt(options.gasLimit || 10_000_000),
    });
  }

  const execResult = result.execResult || result;

  if (execResult.exceptionError) {
    if (options.verbose && execResult.runState) {
      const { programCounter, opCode, stack, memory } = execResult.runState;
      console.error('\n=== EVM EXCEPTION ===');
      console.error('  PC:', programCounter);
      console.error(
        '  Opcode:',
        opCode,
        `(${opCode !== undefined ? '0x' + opCode.toString(16) : 'unknown'})`,
      );
      if (stack && typeof stack.toArray === 'function') {
        console.error(
          '  Stack:',
          stack.toArray().map((val) => '0x' + val.toString(16)),
        );
      } else if (stack && Array.isArray(stack)) {
        console.error(
          '  Stack:',
          stack.map((val) => '0x' + BigInt(val).toString(16)),
        );
      } else {
        console.error('  Stack: (not available)');
      }
      if (memory && (memory._store || memory._data)) {
        const memBytes = memory._store || memory._data;
        console.error('  Memory:', uint8ArrayToHex(memBytes));
      } else if (memory && memory.toString) {
        console.error('  Memory:', memory.toString());
      } else {
        console.error('  Memory: (not available)');
      }
      console.error('Execution error:', execResult.exceptionError);
      console.error('===================\n');
    }
    return null;
  }

  const returnValue = execResult.returnValue ? uint8ArrayToHex(execResult.returnValue) : '';
  const gasUsed = execResult.executionGasUsed;

  if (!returnValue || returnValue.length === 0) {
    if (options.verbose) {
      console.error('Empty return value - execution may have failed');
      console.error('Gas used:', gasUsed);
    }
    return null;
  }

  return {
    returnValue: '0x' + returnValue,
    returnInt: BigInt('0x' + returnValue),
    gasUsed: gasUsed,
  };
}

export { runEvmBytecode };

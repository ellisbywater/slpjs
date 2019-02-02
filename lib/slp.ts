import BITBOX from 'bitbox-sdk/lib/bitbox-sdk';
import * as bchaddr from 'bchaddrjs-slp';
import BigNumber from 'bignumber.js';
import { SlpAddressUtxoResult, SlpTransactionDetails, SlpTransactionType, SlpTypeVersion, SlpUtxoJudgement, SlpBalancesResult, utxo } from './slpjs';
import { SlpTokenType1 } from './slptokentype1';
import { Utils } from './utils';

export interface PushDataOperation {
    opcode: number, 
    data: Buffer|null
}

export interface configBuildGenesisOpReturn {
    ticker: string|null;
    name: string|null;
    documentUri: string|null;
    hash: Buffer|null,
    decimals: number;
    batonVout: number|null; // normally this is null (for fixed supply) or 2+ for flexible
    initialQuantity: BigNumber
}

export interface configBuildMintOpReturn {
    tokenIdHex: string;
    batonVout: number|null; // normally this is null (for fixed supply) or 2+ for flexible
    mintQuantity: BigNumber;
}

export interface configBuildSendOpReturn {
    tokenIdHex: string; 
    outputQtyArray: BigNumber[]
}

export interface configBuildRawGenesisTx {
    slpGenesisOpReturn: Buffer; 
    mintReceiverAddress: string;
    mintReceiverSatoshis?: BigNumber;
    batonReceiverAddress: string;
    batonReceiverSatoshis?: BigNumber;
    bchChangeReceiverAddress: string;
    input_utxos: utxo[];
}

export interface configBuildRawSendTx {
    slpSendOpReturn: Buffer;
    input_token_utxos: utxo[];//AddressUtxoResultExtended[];
    tokenReceiverAddressArray: string[];
    bchChangeReceiverAddress: string;
}

export interface configBuildRawMintTx {
    slpMintOpReturn: Buffer;
    mintReceiverAddress: string;
    mintReceiverSatoshis?: BigNumber;
    batonReceiverAddress: string|null;
    batonReceiverSatoshis?: BigNumber;
    bchChangeReceiverAddress: string;
    input_baton_utxos: utxo[];
}

type AsyncValidatorFunction = (tokenIds: string[]) => Promise<string[]>

export interface SlpProxyValidator {
    validatorUrl: string;
    validateSlpTransactions: AsyncValidatorFunction;
    processUtxosForSlp(utxos: SlpAddressUtxoResult[], validatorOverride?: SlpProxyValidator): Promise<SlpBalancesResult>;
} 

export class Slp {
    BITBOX: BITBOX;
    networkstring: string;
    constructor(BITBOX) {
        this.BITBOX = BITBOX;
    }

    get lokadIdHex() { return "534c5000" }

    buildGenesisOpReturn(config: configBuildGenesisOpReturn, type = 0x01) {
        let hash;
        try { hash = config.hash.toString('hex')
        } catch (_) { hash = null }
        
        return SlpTokenType1.buildGenesisOpReturn(
            config.ticker,
            config.name,
            config.documentUri,
            hash,
            config.decimals,
            config.batonVout,
            config.initialQuantity
        )
    }

    buildMintOpReturn(config: configBuildMintOpReturn, type = 0x01) {
        return SlpTokenType1.buildMintOpReturn(
            config.tokenIdHex,
            config.batonVout,
            config.mintQuantity
        )
    }

    buildSendOpReturn(config: configBuildSendOpReturn, type = 0x01) {
        return SlpTokenType1.buildSendOpReturn(
            config.tokenIdHex,
            config.outputQtyArray
        )
    }

    buildRawGenesisTx(config: configBuildRawGenesisTx, type = 0x01) {

        if(config.mintReceiverSatoshis === undefined)
            config.mintReceiverSatoshis = new BigNumber(546);

        if(config.batonReceiverSatoshis === undefined)
            config.batonReceiverSatoshis = new BigNumber(546); 

        // Make sure we're not spending any token or baton UTXOs
        config.input_utxos.forEach(txo => {
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.NOT_SLP)
                return
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_TOKEN) {
                throw Error("Input UTXOs included a token for another tokenId.")
            }
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_BATON)
                throw Error("Cannot spend a minting baton.")
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.INVALID_TOKEN_DAG || txo.slpUtxoJudgement === SlpUtxoJudgement.INVALID_BATON_DAG)
                throw Error("Cannot currently spend tokens and baton with invalid DAGs.")
            throw Error("Cannot spend utxo with no SLP judgement.")
        })

        // Check for slp formatted addresses
        if (!bchaddr.isSlpAddress(config.mintReceiverAddress))
            throw new Error("Not an SLP address.");
        if (config.batonReceiverAddress != null && !bchaddr.isSlpAddress(config.batonReceiverAddress))
            throw new Error("Not an SLP address.");

        config.mintReceiverAddress = bchaddr.toCashAddress(config.mintReceiverAddress);

        let transactionBuilder = new this.BITBOX.TransactionBuilder(Utils.txnBuilderString(config.mintReceiverAddress));
        let satoshis = new BigNumber(0);
        config.input_utxos.forEach(token_utxo => {
            transactionBuilder.addInput(token_utxo.txid, token_utxo.vout);
            satoshis = satoshis.plus(token_utxo.satoshis);
        });

        let genesisCost = this.calculateGenesisCost(config.slpGenesisOpReturn.length, config.input_utxos.length, config.batonReceiverAddress, config.bchChangeReceiverAddress);
        let bchChangeAfterFeeSatoshis: BigNumber = satoshis.minus(genesisCost);

        // Genesis OpReturn
        transactionBuilder.addOutput(config.slpGenesisOpReturn, 0);

        // Genesis token mint
        transactionBuilder.addOutput(config.mintReceiverAddress, config.mintReceiverSatoshis.toNumber());
        //bchChangeAfterFeeSatoshis -= config.mintReceiverSatoshis;

        // Baton address (optional)
        if (config.batonReceiverAddress != null) {
            config.batonReceiverAddress = bchaddr.toCashAddress(config.batonReceiverAddress);
            if(this.parseSlpOutputScript(config.slpGenesisOpReturn).batonVout !== 2)
                throw Error("batonVout in transaction does not match OP_RETURN data.")
            transactionBuilder.addOutput(config.batonReceiverAddress, config.batonReceiverSatoshis.toNumber());
            //bchChangeAfterFeeSatoshis -= config.batonReceiverSatoshis;
        }

        // Change (optional)
        if (config.bchChangeReceiverAddress != null && bchChangeAfterFeeSatoshis.isGreaterThan(new BigNumber(546))) {
            config.bchChangeReceiverAddress = bchaddr.toCashAddress(config.bchChangeReceiverAddress);
            transactionBuilder.addOutput(config.bchChangeReceiverAddress, bchChangeAfterFeeSatoshis.toNumber());
        }

        // sign inputs
        let i = 0;
        for (const txo of config.input_utxos) {
            let paymentKeyPair = this.BITBOX.ECPair.fromWIF(txo.wif);
            transactionBuilder.sign(i, paymentKeyPair, null, transactionBuilder.hashTypes.SIGHASH_ALL, txo.satoshis.toNumber());
            i++;
        }

        let tx = transactionBuilder.build().toHex();

        // Check For Low Fee
        let outValue: number = transactionBuilder.transaction.tx.outs.reduce((v,o)=>v+=o.value, 0);
        let inValue: BigNumber = config.input_utxos.reduce((v,i)=>v=v.plus(i.satoshis), new BigNumber(0))
        if(inValue.minus(outValue).isLessThanOrEqualTo(tx.length/2))
            throw Error("Transaction fee is not high enough.")

        // TODO: Check for fee too large or send leftover to target address

        return tx;
    }

    buildRawSendTx(config: configBuildRawSendTx, type = 0x01) {

        const sendMsg = this.parseSlpOutputScript(config.slpSendOpReturn);
        
        config.tokenReceiverAddressArray.forEach(outputAddress => {
            if (!bchaddr.isSlpAddress(outputAddress))
                throw new Error("Token receiver address not in SLP format.");
        });

        // Make sure not spending any other tokens or baton UTXOs
        let tokenInputQty = new BigNumber(0);
        config.input_token_utxos.forEach(txo => {
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.NOT_SLP)
                return
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_TOKEN) {
                if(txo.slpTransactionDetails.tokenIdHex !== sendMsg.tokenIdHex)
                    throw Error("Input UTXOs included a token for another tokenId.")
                tokenInputQty = tokenInputQty.plus(txo.slpUtxoJudgementAmount);
                return
            }
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_BATON)
                throw Error("Cannot spend a minting baton.")
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.INVALID_TOKEN_DAG || txo.slpUtxoJudgement === SlpUtxoJudgement.INVALID_BATON_DAG)
                throw Error("Cannot currently spend UTXOs with invalid DAGs.")
            throw Error("Cannot spend utxo with no SLP judgement.")
        })

        // Make sure the number of output receivers matches the outputs in the OP_RETURN message.
        let chgAddr = config.bchChangeReceiverAddress ? 1 : 0;
        if(config.tokenReceiverAddressArray.length + chgAddr !== sendMsg.sendOutputs.length)
            throw Error("Number of token receivers in config does not match the OP_RETURN outputs")

        // Make sure token inputs equals token outputs in OP_RETURN
        let outputTokenQty = sendMsg.sendOutputs.reduce((v,o)=>v=v.plus(o), new BigNumber(0));
        if(!tokenInputQty.isEqualTo(outputTokenQty))
            throw Error("Token input quantity does not match token outputs.")

        let transactionBuilder = new this.BITBOX.TransactionBuilder(Utils.txnBuilderString(config.tokenReceiverAddressArray[0]));
        let inputSatoshis = new BigNumber(0);
        config.input_token_utxos.forEach(token_utxo => {
            transactionBuilder.addInput(token_utxo.txid, token_utxo.vout);
            inputSatoshis = inputSatoshis.plus(token_utxo.satoshis);
        });

        let sendCost = this.calculateSendCost(config.slpSendOpReturn.length, config.input_token_utxos.length, config.tokenReceiverAddressArray.length, config.bchChangeReceiverAddress);
        let bchChangeAfterFeeSatoshis = inputSatoshis.minus(sendCost);

        // Genesis OpReturn
        transactionBuilder.addOutput(config.slpSendOpReturn, 0);

        // Token distribution outputs
        config.tokenReceiverAddressArray.forEach((outputAddress) => {
            outputAddress = bchaddr.toCashAddress(outputAddress);
            transactionBuilder.addOutput(outputAddress, 546);
        })

        // Change
        if (config.bchChangeReceiverAddress != null && bchChangeAfterFeeSatoshis.isGreaterThan(new BigNumber(546))) {
            config.bchChangeReceiverAddress = bchaddr.toCashAddress(config.bchChangeReceiverAddress);
            transactionBuilder.addOutput(config.bchChangeReceiverAddress, bchChangeAfterFeeSatoshis.toNumber());
        }

        // sign inputs
        let i = 0;
        for (const txo of config.input_token_utxos) {
            let paymentKeyPair = this.BITBOX.ECPair.fromWIF(txo.wif);
            transactionBuilder.sign(i, paymentKeyPair, null, transactionBuilder.hashTypes.SIGHASH_ALL, txo.satoshis.toNumber());
            i++;
        }

        let tx = transactionBuilder.build().toHex();

        // Check For Low Fee
        let outValue: number = transactionBuilder.transaction.tx.outs.reduce((v,o)=>v+=o.value, 0);
        let inValue: BigNumber = config.input_token_utxos.reduce((v,i)=>v=v.plus(i.satoshis), new BigNumber(0))
        if(inValue.minus(outValue).isLessThanOrEqualTo(tx.length/2))
            throw Error("Transaction fee is not high enough.")

        // TODO: Check for fee too large or send leftover to target address

        return tx;
    }

    buildRawMintTx(config: configBuildRawMintTx, type = 0x01) {

        let mintMsg = this.parseSlpOutputScript(config.slpMintOpReturn);

        if(config.mintReceiverSatoshis === undefined)
            config.mintReceiverSatoshis = new BigNumber(546);

        if(config.batonReceiverSatoshis === undefined)
            config.batonReceiverSatoshis = new BigNumber(546); 

        // Check for slp formatted addresses
        if (!bchaddr.isSlpAddress(config.mintReceiverAddress)) {
            throw new Error("Mint receiver address not in SLP format.");
        }
        if (config.batonReceiverAddress != null && !bchaddr.isSlpAddress(config.batonReceiverAddress)) {
            throw new Error("Baton receiver address not in SLP format.");
        }
        config.mintReceiverAddress = bchaddr.toCashAddress(config.mintReceiverAddress);
        config.batonReceiverAddress = bchaddr.toCashAddress(config.batonReceiverAddress);

        // Make sure inputs don't include spending any tokens or batons for other tokenIds
        config.input_baton_utxos.forEach(txo => {
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.NOT_SLP)
                return
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_TOKEN)
                throw Error("Input UTXOs should not include any tokens.")
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_BATON) {
                if(txo.slpTransactionDetails.tokenIdHex !== mintMsg.tokenIdHex)
                    throw Error("Cannot spend a minting baton.")
                return
            }
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.INVALID_TOKEN_DAG || txo.slpUtxoJudgement === SlpUtxoJudgement.INVALID_BATON_DAG)
                throw Error("Cannot currently spend UTXOs with invalid DAGs.")
            throw Error("Cannot spend utxo with no SLP judgement.")
        })

        // Make sure inputs include the baton for this tokenId
        if(!config.input_baton_utxos.find(o => o.slpUtxoJudgement === SlpUtxoJudgement.SLP_BATON))
            Error("There is no baton included with the input UTXOs.")

        let transactionBuilder = new this.BITBOX.TransactionBuilder(Utils.txnBuilderString(config.mintReceiverAddress));
        let satoshis = new BigNumber(0);
        config.input_baton_utxos.forEach(baton_utxo => {
            transactionBuilder.addInput(baton_utxo.txid, baton_utxo.vout);
            satoshis = satoshis.plus(baton_utxo.satoshis);
        });

        let mintCost = this.calculateGenesisCost(config.slpMintOpReturn.length, config.input_baton_utxos.length, config.batonReceiverAddress, config.bchChangeReceiverAddress);
        let bchChangeAfterFeeSatoshis = satoshis.minus(mintCost);

        // Mint OpReturn
        transactionBuilder.addOutput(config.slpMintOpReturn, 0);

        // Mint token mint
        transactionBuilder.addOutput(config.mintReceiverAddress, config.mintReceiverSatoshis.toNumber());
        //bchChangeAfterFeeSatoshis -= config.mintReceiverSatoshis;

        // Baton address (optional)
        if (config.batonReceiverAddress !== null) {
            config.batonReceiverAddress = bchaddr.toCashAddress(config.batonReceiverAddress);
            if(this.parseSlpOutputScript(config.slpMintOpReturn).batonVout !== 2)
                throw Error("batonVout in transaction does not match OP_RETURN data.")
            transactionBuilder.addOutput(config.batonReceiverAddress, config.batonReceiverSatoshis.toNumber());
            //bchChangeAfterFeeSatoshis -= config.batonReceiverSatoshis;
        }

        // Change (optional)
        if (config.bchChangeReceiverAddress !== null && bchChangeAfterFeeSatoshis.isGreaterThan(new BigNumber(546))) {
            config.bchChangeReceiverAddress = bchaddr.toCashAddress(config.bchChangeReceiverAddress);
            transactionBuilder.addOutput(config.bchChangeReceiverAddress, bchChangeAfterFeeSatoshis.toNumber());
        }

        // sign inputs
        let i = 0;
        for (const txo of config.input_baton_utxos) {
            let paymentKeyPair = this.BITBOX.ECPair.fromWIF(txo.wif);
            transactionBuilder.sign(i, paymentKeyPair, null, transactionBuilder.hashTypes.SIGHASH_ALL, txo.satoshis.toNumber());
            i++;
        }

        let tx = transactionBuilder.build().toHex();

        // Check For Low Fee
        let outValue: number = transactionBuilder.transaction.tx.outs.reduce((v,o)=>v+=o.value, 0);
        let inValue: BigNumber = config.input_baton_utxos.reduce((v,i)=>v=v.plus(i.satoshis), new BigNumber(0))
        if(inValue.minus(outValue).isLessThanOrEqualTo(tx.length/2))
            throw Error("Transaction fee is not high enough.")

        // TODO: Check for fee too large or send leftover to target address

        return tx;
    }

    parseSlpOutputScript(outputScript: Buffer) {
        let slpMsg = <SlpTransactionDetails>{};
        let chunks: (Buffer|null)[];
        try {
            chunks = this.parseOpReturnToChunks(outputScript);
        } catch(e) { 
            //console.log(e);
            throw Error('Bad OP_RETURN');
        }
        if(chunks.length === 0)
            throw Error('Empty OP_RETURN');
        if(!chunks[0].equals(Buffer.from(this.lokadIdHex, 'hex')))
            throw Error('No SLP');
        if(chunks.length === 1)
            throw Error("Missing token_type");
        // # check if the token version is supported
        slpMsg.type = Slp.parseChunkToInt(chunks[1], 1, 2, true);
        if(slpMsg.type !== SlpTypeVersion.TokenType1)
            throw Error('Unsupported token type:' + slpMsg.type);
        if(chunks.length === 2)
            throw Error('Missing SLP transaction type');
        try {
            slpMsg.transactionType = SlpTransactionType[chunks[2].toString('ascii')]
        } catch(_){
            throw Error('Bad transaction type');
        }
        if(slpMsg.transactionType === SlpTransactionType.GENESIS) {
            if(chunks.length !== 10)
                throw Error('GENESIS with incorrect number of parameters');
            slpMsg.symbol = chunks[3] ? chunks[3].toString('utf8') : '';
            slpMsg.name = chunks[4] ? chunks[4].toString('utf8') : '';
            slpMsg.documentUri = chunks[5] ? chunks[5].toString('utf8') : '';
            slpMsg.documentSha256 = chunks[6] ? chunks[6] : null;
            if(slpMsg.documentSha256) {
                if(slpMsg.documentSha256.length !== 0 && slpMsg.documentSha256.length !== 32)
                    throw Error('Token document hash is incorrect length');
            }
            slpMsg.decimals = Slp.parseChunkToInt(chunks[7], 1, 1, true);
            if(slpMsg.decimals > 9)
                throw Error('Too many decimals')
            slpMsg.batonVout = chunks[8] ? Slp.parseChunkToInt(chunks[8], 1, 1) : null;
            if(slpMsg.batonVout !== null){
                if (slpMsg.batonVout < 2) 
                    throw Error('Mint baton cannot be on vout=0 or 1');
                slpMsg.containsBaton = true;
            }
            slpMsg.genesisOrMintQuantity = (new BigNumber(chunks[9].readUInt32BE(0).toString())).multipliedBy(2**32).plus(chunks[9].readUInt32BE(4).toString());
        }
        else if(slpMsg.transactionType === SlpTransactionType.SEND) {
            if(chunks.length < 4)
                throw Error('SEND with too few parameters');
            if(chunks[3].length !== 32)
                throw Error('token_id is wrong length');
            slpMsg.tokenIdHex = chunks[3].toString('hex');
            // # Note that we put an explicit 0 for  ['token_output'][0] since it
            // # corresponds to vout=0, which is the OP_RETURN tx output.
            // # ['token_output'][1] is the first token output given by the SLP
            // # message, i.e., the number listed as `token_output_quantity1` in the
            // # spec, which goes to tx output vout=1.
            slpMsg.sendOutputs = [];
            slpMsg.sendOutputs.push(new BigNumber(0));
            chunks.slice(4).forEach(chunk => {
                if(chunk.length !== 8)
                    throw Error('SEND quantities must be 8-bytes each.');
                slpMsg.sendOutputs.push((new BigNumber(chunk.readUInt32BE(0).toString())).multipliedBy(2**32).plus(new BigNumber(chunk.readUInt32BE(4).toString())));
            });
            // # maximum 19 allowed token outputs, plus 1 for the explicit [0] we inserted.
            if(slpMsg.sendOutputs.length < 2)
                throw Error('Missing output amounts');
            if(slpMsg.sendOutputs.length > 20)
                throw Error('More than 19 output amounts');
        }
        else if(slpMsg.transactionType === SlpTransactionType.MINT) {
            if(chunks.length != 6)
                throw Error('MINT with incorrect number of parameters');
            if(chunks[3].length != 32)
                throw Error('token_id is wrong length');
            slpMsg.tokenIdHex = chunks[3].toString('hex');
            slpMsg.batonVout = chunks[4] ? Slp.parseChunkToInt(chunks[4],1,1) : null;
            if(slpMsg.batonVout !== null){
                if(slpMsg.batonVout < 2)
                    throw Error('Mint baton cannot be on vout=0 or 1');
                slpMsg.containsBaton = true;
            }
            slpMsg.genesisOrMintQuantity = (new BigNumber(chunks[5].readUInt32BE(0).toString())).multipliedBy(2**32).plus((new BigNumber(chunks[5].readUInt32BE(4).toString())));
        }
        else
            throw Error('Bad transaction type');
        return slpMsg;
    }
 
    static parseChunkToInt(intBytes: Buffer, minByteLen: number, maxByteLen: number, raise_on_Null = false) {
        // # Parse data as unsigned-big-endian encoded integer.
        // # For empty data different possibilities may occur:
        // #      minByteLen <= 0 : return 0
        // #      raise_on_Null == False and minByteLen > 0: return None
        // #      raise_on_Null == True and minByteLen > 0:  raise SlpInvalidOutputMessage
        if(intBytes.length >= minByteLen && intBytes.length <= maxByteLen)
            return intBytes.readUIntBE(0, intBytes.length)
        if(intBytes.length === 0 && !raise_on_Null)
            return null;
        throw Error('Field has wrong length');
    }

    // get list of data chunks resulting from data push operations
    parseOpReturnToChunks(script: Buffer, allow_op_0=false, allow_op_number=false) {
        // """Extract pushed bytes after opreturn. Returns list of bytes() objects,
        // one per push.
        let ops: PushDataOperation[];
    
        // Strict refusal of non-push opcodes; bad scripts throw OpreturnError."""
        try {
            ops = this.getScriptOperations(script);
        } catch(e) {
            //console.log(e);
            throw Error('Script error');
        }

        if(ops[0].opcode != this.BITBOX.Script.opcodes.OP_RETURN)
            throw Error('No OP_RETURN');
    
        let chunks: (Buffer|null)[] = [];
        ops.slice(1).forEach(opitem => {
            if(opitem.opcode > this.BITBOX.Script.opcodes.OP_16)
                throw Error("Non-push opcode");
            if(opitem.opcode > this.BITBOX.Script.opcodes.OP_PUSHDATA4) {
                if(opitem.opcode === 80)
                    throw Error('Non-push opcode');
                if(!allow_op_number)
                    throw Error('OP_1NEGATE to OP_16 not allowed');
                if(opitem.opcode === this.BITBOX.Script.opcodes.OP_1NEGATE)
                    opitem.data = Buffer.from([0x81]);
                else // OP_1 - OP_16
                    opitem.data = Buffer.from([opitem.opcode - 80]);
            }
            if(opitem.opcode === this.BITBOX.Script.opcodes.OP_0 && !allow_op_0){
                throw Error('OP_0 not allowed');
            }
            chunks.push(opitem.data)
        });
        //console.log(chunks);
        return chunks
    }

    // Get a list of operations with accompanying push data (if a push opcode)
    getScriptOperations(script: Buffer) {
        let ops: PushDataOperation[] = [];
        try {
            let n = 0;
            let dlen: number;
            while (n < script.length) {
                let op: PushDataOperation = { opcode: script[n], data: null }
                n += 1;
                if(op.opcode <= this.BITBOX.Script.opcodes.OP_PUSHDATA4) {
                    if(op.opcode < this.BITBOX.Script.opcodes.OP_PUSHDATA1)
                        dlen = op.opcode;
                    else if(op.opcode === this.BITBOX.Script.opcodes.OP_PUSHDATA1) {
                        dlen = script[n];
                        n += 1;
                    }
                    else if(op.opcode === this.BITBOX.Script.opcodes.OP_PUSHDATA2) {
                        dlen = script.slice(n, n + 2).readUIntLE(0,2);
                        n += 2;
                    }
                    else {
                        dlen = script.slice(n, n + 4).readUIntLE(0,4);
                        n += 4;
                    }
                    if((n + dlen) > script.length) {
                        throw Error('IndexError');
                    }
                    if(dlen > 0)
                        op.data = script.slice(n, n + dlen);
                    n += dlen
                }
                ops.push(op);
            }
        } catch(e) {
            //console.log(e);
            throw Error('truncated script')
        }
        return ops;
    }

    calculateGenesisCost(genesisOpReturnLength: number, inputUtxoSize: number, batonAddress?: string, bchChangeAddress?: string, feeRate = 1) {
        return this.calculateMintOrGenesisCost(genesisOpReturnLength, inputUtxoSize, batonAddress, bchChangeAddress, feeRate);
    }

    calculateMintCost(mintOpReturnLength: number, inputUtxoSize: number, batonAddress?: string, bchChangeAddress?: string, feeRate = 1) {
        return this.calculateMintOrGenesisCost(mintOpReturnLength, inputUtxoSize, batonAddress, bchChangeAddress, feeRate);
    }

    calculateMintOrGenesisCost(mintOpReturnLength: number, inputUtxoSize: number, batonAddress?: string, bchChangeAddress?: string, feeRate: number = 1) {
        let outputs = 1
        let nonfeeoutputs = 546
        if (batonAddress !== null && batonAddress !== undefined) {
            nonfeeoutputs += 546
            outputs += 1
        }

        if (bchChangeAddress !== null && bchChangeAddress !== undefined) {
            outputs += 1
        }

        let fee = this.BITBOX.BitcoinCash.getByteCount({ P2PKH: inputUtxoSize }, { P2PKH: outputs })
        fee += mintOpReturnLength
        fee += 10 // added to account for OP_RETURN ammount of 0000000000000000
        fee *= feeRate
        //console.log("MINT/GENESIS cost before outputs: " + fee.toString());
        fee += nonfeeoutputs
        //console.log("MINT/GENESIS cost after outputs are added: " + fee.toString());
        return fee
    }

    calculateSendCost(sendOpReturnLength: number, inputUtxoSize: number, outputAddressArraySize: number, bchChangeAddress?: string, feeRate = 1) {
        let outputs = outputAddressArraySize
        let nonfeeoutputs = outputAddressArraySize * 546

        if (bchChangeAddress != null) {
            outputs += 1
        }

        let fee = this.BITBOX.BitcoinCash.getByteCount({ P2PKH: inputUtxoSize }, { P2PKH: outputs })
        fee += sendOpReturnLength
        fee += 10 // added to account for OP_RETURN ammount of 0000000000000000
        fee *= feeRate
        //console.log("SEND cost before outputs: " + fee.toString());
        fee += nonfeeoutputs
        //console.log("SEND cost after outputs are added: " + fee.toString());
        return fee
    }

    static preSendSlpJudgementCheck(txo: SlpAddressUtxoResult, tokenId: string){
        if (txo.slpUtxoJudgement === undefined || txo.slpUtxoJudgement === null || txo.slpUtxoJudgement === SlpUtxoJudgement.UNKNOWN)
            throw Error("There at least one input UTXO that does not have a proper SLP judgement")
        if (txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_BATON)
            throw Error("There is at least one input UTXO that is a baton.  You can only spend batons in a MINT transaction.")
        if (txo.slpTransactionDetails) {
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_TOKEN) {
                if(!txo.slpUtxoJudgementAmount)
                    throw Error("There is at least one input token that does not have the 'slpUtxoJudgementAmount' property set.")
                if(txo.slpTransactionDetails.tokenIdHex !== tokenId)
                    throw Error("There is at least one input UTXO that is a different SLP token than the one specified.")
                return txo.slpTransactionDetails.tokenIdHex === tokenId;
            }
        } 
        return false;
    }

    async processUtxosForSlpAbstract(utxos: SlpAddressUtxoResult[], asyncSlpValidator: SlpProxyValidator) {
        
        // 1) parse SLP OP_RETURN and cast initial SLP judgement, based on OP_RETURN only.
        for(let txo of utxos) {
            this.applyInitialSlpJudgement(txo);
            if(txo.slpUtxoJudgement === SlpUtxoJudgement.UNKNOWN || txo.slpUtxoJudgement === undefined)
                throw Error('Utxo SLP judgement has not been set, unknown error.')
        }
    
        // 2) Cast final SLP judgement using the supplied async validator
        await this.applyFinalSlpJudgement(asyncSlpValidator, utxos);
        
        // 3) Prepare results object
        const result: SlpBalancesResult = this.computeSlpBalances(utxos);
    
        // 4) Check that all UTXOs have been categorized
        let tokenTxoCount = 0;
        for(let id in result.slpTokenUtxos) tokenTxoCount += result.slpTokenUtxos[id].length;
        let batonTxoCount = 0;
        for(let id in result.slpBatonUtxos) batonTxoCount += result.slpBatonUtxos[id].length;
        if(utxos.length !== (tokenTxoCount + batonTxoCount + result.nonSlpUtxos.length + result.invalidBatonUtxos.length + result.invalidTokenUtxos.length))
            throw Error('Not all UTXOs have been categorized. Unknown Error.');
    
        return result;
    }

    private computeSlpBalances(utxos: SlpAddressUtxoResult[]) {
        const result: SlpBalancesResult = {
            satoshis_available_bch: 0,
            satoshis_in_slp_baton: 0,
            satoshis_in_slp_token: 0,
            satoshis_in_invalid_token_dag: 0,
            satoshis_in_invalid_baton_dag: 0,
            slpTokenBalances: {},
            slpTokenUtxos: {},
            slpBatonUtxos: {},
            nonSlpUtxos: [],
            invalidTokenUtxos: [],
            invalidBatonUtxos: []
        };
        // 5) Loop through UTXO set and accumulate balances for type of utxo, organize the Utxos into their categories.
        for (const txo of utxos) {
            if (txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_TOKEN) {
                if (!(txo.slpTransactionDetails.tokenIdHex in result.slpTokenBalances))
                    result.slpTokenBalances[txo.slpTransactionDetails.tokenIdHex] = new BigNumber(0);
                if (txo.slpTransactionDetails.transactionType === SlpTransactionType.GENESIS || txo.slpTransactionDetails.transactionType === SlpTransactionType.MINT) {
                    result.slpTokenBalances[txo.slpTransactionDetails.tokenIdHex] = result.slpTokenBalances[txo.slpTransactionDetails.tokenIdHex].plus(<BigNumber>txo.slpTransactionDetails.genesisOrMintQuantity);
                }
                else if (txo.slpTransactionDetails.transactionType === SlpTransactionType.SEND && txo.slpTransactionDetails.sendOutputs) {
                    let qty = txo.slpTransactionDetails.sendOutputs[txo.vout];
                    result.slpTokenBalances[txo.slpTransactionDetails.tokenIdHex] = result.slpTokenBalances[txo.slpTransactionDetails.tokenIdHex].plus(qty);
                }
                else {
                    throw Error('Unknown Error: cannot have an SLP_TOKEN that is not from GENESIS, MINT, or SEND.');
                }
                result.satoshis_in_slp_token += txo.satoshis;
                if(!(txo.slpTransactionDetails.tokenIdHex in result.slpTokenUtxos))
                    result.slpTokenUtxos[txo.slpTransactionDetails.tokenIdHex] = [];
                result.slpTokenUtxos[txo.slpTransactionDetails.tokenIdHex].push(txo);
            }
            else if (txo.slpUtxoJudgement === SlpUtxoJudgement.SLP_BATON) {
                result.satoshis_in_slp_baton += txo.satoshis;
                if(!(txo.slpTransactionDetails.tokenIdHex in result.slpBatonUtxos))
                    result.slpBatonUtxos[txo.slpTransactionDetails.tokenIdHex] = [];
                result.slpBatonUtxos[txo.slpTransactionDetails.tokenIdHex].push(txo);
            }
            else if (txo.slpUtxoJudgement === SlpUtxoJudgement.INVALID_TOKEN_DAG) {
                result.satoshis_in_invalid_token_dag += txo.satoshis;
                result.invalidTokenUtxos.push(txo);
            }
            else if (txo.slpUtxoJudgement === SlpUtxoJudgement.INVALID_BATON_DAG) {
                result.satoshis_in_invalid_baton_dag += txo.satoshis;
                result.invalidBatonUtxos.push(txo);
            }
            else {
                result.satoshis_available_bch += txo.satoshis;
                result.nonSlpUtxos.push(txo);
            }
        }
        return result;
    }

    private applyInitialSlpJudgement(txo: SlpAddressUtxoResult) {
        try {
            let vout = txo.tx.vout.find(vout => vout.n === 0);
            if (!vout)
                throw 'Utxo contains no Vout!';
            let vout0script = Buffer.from(vout.scriptPubKey.hex, 'hex');
            txo.slpTransactionDetails = this.parseSlpOutputScript(vout0script);
            // populate txid for GENESIS
            if (txo.slpTransactionDetails.transactionType === SlpTransactionType.GENESIS)
                txo.slpTransactionDetails.tokenIdHex = txo.txid;
            // apply initial SLP judgement to the UTXO (based on OP_RETURN parsing ONLY! Still need to validate the DAG for possible tokens and batons!)
            if (txo.slpTransactionDetails.transactionType === SlpTransactionType.GENESIS ||
                txo.slpTransactionDetails.transactionType === SlpTransactionType.MINT) {
                if (txo.slpTransactionDetails.containsBaton && txo.slpTransactionDetails.batonVout === txo.vout) {
                    txo.slpUtxoJudgement = SlpUtxoJudgement.SLP_BATON;
                }
                else if (txo.vout === 1 && txo.slpTransactionDetails.genesisOrMintQuantity.isGreaterThan(0)) {
                    txo.slpUtxoJudgement = SlpUtxoJudgement.SLP_TOKEN;
                    txo.slpUtxoJudgementAmount = txo.slpTransactionDetails.genesisOrMintQuantity;
                }
                else
                    txo.slpUtxoJudgement = SlpUtxoJudgement.NOT_SLP;
            }
            else if (txo.slpTransactionDetails.transactionType === SlpTransactionType.SEND && txo.slpTransactionDetails.sendOutputs) {
                if (txo.vout > 0 && txo.vout < txo.slpTransactionDetails.sendOutputs.length) {
                    txo.slpUtxoJudgement = SlpUtxoJudgement.SLP_TOKEN;
                    txo.slpUtxoJudgementAmount = txo.slpTransactionDetails.sendOutputs[txo.vout];
                }
                else
                    txo.slpUtxoJudgement = SlpUtxoJudgement.NOT_SLP;
            } else {
                txo.slpUtxoJudgement = SlpUtxoJudgement.NOT_SLP;
            }
        }
        catch (e) {
            // any errors in parsing SLP OP_RETURN means the TXN is NOT SLP.
            txo.slpUtxoJudgement = SlpUtxoJudgement.NOT_SLP;
        }
    }

    private async applyFinalSlpJudgement(asyncSlpValidator: SlpProxyValidator, utxos: SlpAddressUtxoResult[]) {

        let validSLPTx: string[] = await asyncSlpValidator.validateSlpTransactions([
            ...new Set(utxos.filter(txOut => {
                if (txOut.slpTransactionDetails &&
                    txOut.slpUtxoJudgement !== SlpUtxoJudgement.UNKNOWN &&
                    txOut.slpUtxoJudgement !== SlpUtxoJudgement.NOT_SLP)
                    return true;
                return false;
            }).map(txOut => txOut.txid))
        ]);

        utxos.forEach(utxo => {
            if (!(validSLPTx.includes(utxo.txid))) {
                if (utxo.slpUtxoJudgement === SlpUtxoJudgement.SLP_TOKEN) {
                    utxo.slpUtxoJudgement = SlpUtxoJudgement.INVALID_TOKEN_DAG;
                }
                else if (utxo.slpUtxoJudgement === SlpUtxoJudgement.SLP_BATON) {
                    utxo.slpUtxoJudgement = SlpUtxoJudgement.INVALID_BATON_DAG;
                }
            }
        });
    }
}
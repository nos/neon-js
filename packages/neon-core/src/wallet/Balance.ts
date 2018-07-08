import { ASSETS } from "../consts";
import { Query } from "../rpc";
import { Transaction } from "../tx";
import { BaseTransaction } from "../tx/transaction/BaseTransaction";
import Fixed8 from "../u/Fixed8";
import AssetBalance, { AssetBalanceLike } from "./components/AssetBalance";
import Coin from "./components/Coin";

export interface BalanceLike {
  address: string;
  net: string;
  assetSymbols: string[];
  assets: { [sym: string]: Partial<AssetBalanceLike> };
  tokenSymbols: string[];
  tokens: { [sym: string]: number | string | Fixed8 };
}

export class Balance {
  public address: string;
  public net: string;
  public assetSymbols: string[];
  public assets: { [sym: string]: AssetBalance };
  public tokenSymbols: string[];
  public tokens: { [sym: string]: Fixed8 };

  constructor(bal: Partial<BalanceLike> = {}) {
    /** The address for this Balance */
    this.address = bal.address || "";
    /** The network for this Balance */
    this.net = bal.net || "NoNet";
    /** The symbols of assets found in this Balance. Use this symbol to find the corresponding key in the assets object. */
    this.assetSymbols = [];
    /** The object containing the balances for each asset keyed by its symbol. */
    this.assets = {};
    if (typeof bal.assets === "object") {
      const keys = Object.keys(bal.assets);
      for (const key of keys) {
        if (typeof bal.assets[key] === "object") {
          this.addAsset(key, bal.assets![key]);
        }
      }
    }
    /** The symbols of the NEP5 tokens in this Balance. Use this symbol to find the corresponding key in the tokens object. */
    this.tokenSymbols = [];
    /** The token balances in this Balance for each token keyed by its symbol. */
    this.tokens = {};
    if (typeof bal.tokens === "object") {
      const keys = Object.keys(bal.tokens);
      for (const key of keys) {
        this.addToken(key, bal.tokens![key]);
      }
    }
  }

  get [Symbol.toStringTag]() {
    return "Balance";
  }

  /**
   * Adds a new asset to this Balance.
   * @param  sym The symbol to refer by. This function will force it to upper-case.
   * @param assetBalance The assetBalance if initialized. Default is a zero balance object.
   * @return this
   */
  public addAsset(sym: string, assetBalance?: Partial<AssetBalanceLike>) {
    sym = sym.toUpperCase();
    this.assetSymbols.push(sym);
    const cleanedAssetBalance = new AssetBalance(assetBalance);
    this.assets[sym] = cleanedAssetBalance;
    return this;
  }

  /**
   * Adds a new NEP-5 Token to this Balance.
   * @param sym - The NEP-5 Token Symbol to refer by.
   * @param tokenBalance - The amount of tokens this account holds.
   * @return this
   */
  public addToken(sym: string, tokenBalance: string | number | Fixed8 = 0) {
    sym = sym.toUpperCase();
    this.tokenSymbols.push(sym);
    this.tokens[sym] = new Fixed8(tokenBalance);
    return this;
  }

  /**
   * Applies a Transaction to a Balance, removing spent coins and adding new coins. This currently applies only to Assets.
   * @param {BaseTransaction|string} tx - Transaction that has been sent and accepted by Node.
   * @param {boolean} confirmed - If confirmed, new coins will be added to unspent. Else, new coins will be added to unconfirmed property first.
   * @return {Balance} this
   */
  public applyTx(
    tx: BaseTransaction | string,
    confirmed: boolean = false
  ): Balance {
    tx = tx instanceof BaseTransaction ? tx : Transaction.deserialize(tx);
    const symbols = this.assetSymbols;
    // Spend coins
    for (const input of tx.inputs) {
      const findFunc = (el: Coin) =>
        el.txid === input.prevHash && el.index === input.prevIndex;
      for (const sym of symbols) {
        const assetBalance = this.assets[sym];
        const ind = assetBalance.unspent.findIndex(findFunc);
        if (ind >= 0) {
          const spentCoin = assetBalance.unspent.splice(ind, 1);
          assetBalance.spent = assetBalance.spent.concat(spentCoin);
          break;
        }
      }
    }

    // Add new coins
    const hash = tx.hash;
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const sym = ASSETS[output.assetId];
      const assetBalance = this.assets[sym];
      if (!assetBalance) {
        this.addAsset(sym);
      }
      const coin = new Coin({ index: i, txid: hash, value: output.value });
      if (confirmed) {
        const findFunc = (el: Coin) =>
          el.txid === coin.txid && el.index === coin.index;
        const unconfirmedIndex = assetBalance.unconfirmed.findIndex(findFunc);
        if (unconfirmedIndex >= 0) {
          assetBalance.unconfirmed.splice(unconfirmedIndex, 1);
        }
        if (!assetBalance.unspent) {
          assetBalance.unspent = [];
        }
        assetBalance.unspent.push(coin);
      } else {
        if (!assetBalance.unconfirmed) {
          assetBalance.unconfirmed = [];
        }
        assetBalance.unconfirmed.push(coin);
      }
      this.assets[sym] = assetBalance;
    }

    return this;
  }

  /**
   * Informs the Balance that the next block is confirmed, thus moving all unconfirmed transaction to unspent.
   * @return {Balance}
   */
  public confirm(): Balance {
    for (const sym of this.assetSymbols) {
      const assetBalance = this.assets[sym];
      assetBalance.unspent = assetBalance.unspent.concat(
        assetBalance.unconfirmed
      );
      assetBalance.unconfirmed = [];
    }
    return this;
  }

  /**
   * Export this class as a plain JS object
   */
  public export(): BalanceLike {
    return {
      net: this.net,
      address: this.address,
      assetSymbols: this.assetSymbols,
      assets: exportAssets(this.assets),
      tokenSymbols: this.tokenSymbols,
      tokens: exportTokens(this.tokens)
    };
  }

  /**
   * Verifies the coins in balance are unspent. This is an expensive call.
   * @param {string} url - NEO Node to check against.
   * @return {Promise<Balance>} Returns this
   */
  public verifyAssets(url: string): Promise<Balance> {
    const promises: Array<Promise<AssetBalance>> = [];
    const symbols = this.assetSymbols;
    symbols.map(key => {
      const assetBalance = this.assets[key];
      promises.push(verifyAssetBalance(url, assetBalance));
    });
    return Promise.all(promises).then(newBalances => {
      symbols.map((sym, i) => {
        this.assets[sym] = newBalances[i];
      });
      return this;
    });
  }
}

export default Balance;

/**
 * Verifies an AssetBalance
 * @param {string} url
 * @param {AssetBalance} assetBalance
 * @return {Promise<AssetBalance>} Returns a new AssetBalance
 */
async function verifyAssetBalance(
  url: string,
  assetBalance: AssetBalance
): Promise<AssetBalance> {
  const newAssetBalance = {
    balance: new Fixed8(0),
    spent: [] as Coin[],
    unspent: [] as Coin[],
    unconfirmed: [] as Coin[]
  };
  const validCoins = await verifyCoins(url, assetBalance.unspent);
  validCoins.forEach((valid, i) => {
    const coin = assetBalance.unspent[i];
    if (valid) {
      newAssetBalance.unspent.push(coin);
      newAssetBalance.balance = newAssetBalance.balance.add(coin.value);
    } else {
      newAssetBalance.spent.push(coin);
    }
  });
  return new AssetBalance(newAssetBalance);
}

/**
 * Verifies a list of Coins
 */
async function verifyCoins(url: string, coinArr: Coin[]): Promise<boolean[]> {
  const promises = coinArr.map(c => verifyCoin(url, c));
  return await Promise.all(promises);
}

async function verifyCoin(url: string, c: Coin) {
  const response = await Query.getTxOut(c.txid, c.index).execute(url);
  if (!response.result) {
    return false;
  }
  return c.index === response.result.n && c.value.equals(response.result.value);
}

function exportAssets(assets: {
  [sym: string]: AssetBalance;
}): { [sym: string]: AssetBalanceLike } {
  const output: { [sym: string]: AssetBalanceLike } = {};
  const keys = Object.keys(assets);
  for (const key of keys) {
    output[key] = assets[key].export();
  }
  return output;
}

function exportTokens(tokens: { [sym: string]: Fixed8 }) {
  const out: { [sym: string]: number } = {};
  Object.keys(tokens).forEach(symbol => {
    out[symbol] = tokens[symbol].toNumber();
  });
  return out;
}
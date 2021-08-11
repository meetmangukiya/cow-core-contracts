import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, constants, Contract, utils, Wallet } from "ethers";
import hre, { ethers, waffle } from "hardhat";
import sinon, { SinonMock } from "sinon";

import {
  Api,
  Environment,
  GetFeeAndQuoteSellOutput,
  PlaceOrderQuery,
} from "../../src/services/api";
import { SupportedNetwork } from "../../src/tasks/ts/deployment";
import { ReferenceToken } from "../../src/tasks/ts/value";
import * as withdrawService from "../../src/tasks/withdrawService";
import { OrderKind, domain, Order, timestamp } from "../../src/ts";
import { deployTestContracts } from "../e2e/fixture";

import { restoreStandardConsole, useDebugConsole } from "./logging";
import { tradeTokensForNoFees } from "./withdraw.test";

describe("Task: withdrawService", () => {
  let deployer: Wallet;
  let solver: SignerWithAddress;
  let trader: Wallet;
  let receiver: Wallet;

  let settlement: Contract;
  let authenticator: Contract;
  let allowanceManager: Contract;

  let weth: Contract;
  let usdc: Contract;
  let dai: Contract;
  let toToken: Contract;

  let apiMock: SinonMock;
  let api: Api;

  beforeEach(async () => {
    const deployment = await deployTestContracts();

    let solverWallet: Wallet;
    ({
      deployer,
      settlement,
      authenticator,
      allowanceManager,
      wallets: [solverWallet, receiver, trader],
    } = deployment);
    const foundSolver = (await ethers.getSigners()).find(
      (signer) => signer.address == solverWallet.address,
    );
    expect(foundSolver).not.to.be.undefined;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    solver = foundSolver!;

    const TestERC20 = await hre.artifacts.readArtifact(
      "src/contracts/test/TestERC20.sol:TestERC20",
    );
    dai = await waffle.deployContract(deployer, TestERC20, ["DAI", 18]);
    usdc = await waffle.deployContract(deployer, TestERC20, ["USDC", 6]);
    weth = await waffle.deployContract(deployer, TestERC20, ["WETH", 18]);
    toToken = await waffle.deployContract(deployer, TestERC20, ["toToken", 2]);

    // environment parameter is unused in mock
    const environment = ("unset environment" as unknown) as Environment;
    api = new Api("mock", environment);
    apiMock = sinon.mock(api);

    const { manager } = deployment;
    await authenticator.connect(manager).addSolver(solver.address);

    const { chainId } = await ethers.provider.getNetwork();
    const domainSeparator = domain(chainId, settlement.address);
    // Trade in order to test automatic retrieval of traded addresses.
    await tradeTokensForNoFees(
      [usdc, weth, dai],
      trader,
      domainSeparator,
      settlement,
      allowanceManager,
      solver,
    );

    useDebugConsole();
  });

  afterEach(function () {
    restoreStandardConsole();
    if (this.currentTest?.isPassed()) {
      apiMock.verify();
    }
  });

  it("should withdraw and dump", async () => {
    const initalState: withdrawService.State = {
      lastUpdateBlock: 0,
      tradedTokens: [],
      nextTokenToTrade: 0,
      pendingTokens: [
        // There are pending tokens that simulate a previous run of the script
        // that tried to withdraw these tokens a number of times.
        { address: dai.address, retries: 3 },
        { address: usdc.address, retries: 4 },
      ],
    };
    const solverDaiBalance = BigNumber.from(utils.parseUnits("100.0", 18));
    // some dai are left over in the solver address from a previous run
    await dai.mint(solver.address, solverDaiBalance);
    // no usdc balance is there, which means that the usdc entry should not
    // affect the final result (this would occur in practice if for example they
    // were withdrawn in the previous run of the script)

    const usdReference: ReferenceToken = {
      address: "0x" + "42".repeat(20),
      symbol: "USD",
      decimals: 42,
    };

    const minValue = "5.0";
    const leftover = "10.0";
    const ethUsdValue = 1000;
    const daiBalance = utils.parseUnits("20.0", 18);
    await dai.mint(settlement.address, daiBalance);
    const usdcBalance = utils.parseUnits("30.0", 6);
    await usdc.mint(settlement.address, usdcBalance);
    const wethBalance = utils.parseUnits("0.04", 18);
    await weth.mint(settlement.address, wethBalance);
    const daiBalanceMinusLeftover = utils.parseUnits("10.0", 18);
    const usdcBalanceMinusLeftover = utils.parseUnits("20.0", 6);
    const wethBalanceMinusLeftover = utils.parseUnits("0.03", 18);

    expect(await dai.balanceOf(receiver.address)).to.deep.equal(constants.Zero);
    expect(await usdc.balanceOf(receiver.address)).to.deep.equal(
      constants.Zero,
    );
    expect(await weth.balanceOf(receiver.address)).to.deep.equal(
      constants.Zero,
    );

    apiMock
      .expects("estimateTradeAmount")
      .withArgs({
        sellToken: usdc.address,
        buyToken: usdReference.address,
        kind: OrderKind.SELL,
        amount: utils.parseUnits("1", 6),
      })
      .once()
      .returns(Promise.resolve(utils.parseUnits("1", usdReference.decimals)));
    apiMock
      .expects("estimateTradeAmount")
      .withArgs({
        sellToken: dai.address,
        buyToken: usdReference.address,
        kind: OrderKind.SELL,
        amount: utils.parseUnits("1", 18),
      })
      .once()
      .returns(Promise.resolve(utils.parseUnits("1", usdReference.decimals)));
    apiMock
      .expects("estimateTradeAmount")
      .withArgs({
        sellToken: weth.address,
        buyToken: usdReference.address,
        kind: OrderKind.SELL,
        amount: utils.parseUnits("1", 18),
      })
      .once()
      .returns(
        Promise.resolve(
          utils.parseUnits("1", usdReference.decimals).mul(ethUsdValue),
        ),
      );

    // fee is low except for dai, where it's larger than the maximum allowed
    const maxFeePercent = 25;
    const usdcFee = usdcBalance.div(42);
    const usdcFeeAndQuote: GetFeeAndQuoteSellOutput = {
      feeAmount: usdcFee,
      buyAmountAfterFee: BigNumber.from(42),
    };
    apiMock
      .expects("getFeeAndQuoteSell")
      .withArgs({
        sellToken: usdc.address,
        buyToken: toToken.address,
        sellAmountBeforeFee: usdcBalanceMinusLeftover,
      })
      .once()
      .returns(Promise.resolve(usdcFeeAndQuote));
    // the solver was storing dai balance from the previous run, which
    // should be included
    const daiBalanceIncludingSolver = daiBalanceMinusLeftover.add(
      solverDaiBalance,
    );
    const daiFee = daiBalanceIncludingSolver.div(2);
    const daiFeeAndQuote: GetFeeAndQuoteSellOutput = {
      feeAmount: BigNumber.from(daiFee),
      buyAmountAfterFee: ("unused" as unknown) as BigNumber,
    };
    apiMock
      .expects("getFeeAndQuoteSell")
      .withArgs({
        sellToken: dai.address,
        buyToken: toToken.address,
        sellAmountBeforeFee: daiBalanceIncludingSolver,
      })
      .once()
      .returns(Promise.resolve(daiFeeAndQuote));
    const wethFee = wethBalance.div(1337);
    const wethFeeAndQuote: GetFeeAndQuoteSellOutput = {
      feeAmount: wethFee,
      buyAmountAfterFee: BigNumber.from(1337),
    };
    apiMock
      .expects("getFeeAndQuoteSell")
      .withArgs({
        sellToken: weth.address,
        buyToken: toToken.address,
        sellAmountBeforeFee: wethBalanceMinusLeftover,
      })
      .once()
      .returns(Promise.resolve(wethFeeAndQuote));

    const validity = 3600;
    function assertGoodOrder(
      order: Order,
      sellToken: string,
      sellAmount: BigNumber,
      buyAmount: BigNumber,
      feeAmount: BigNumber,
    ) {
      expect(order.sellToken).to.deep.equal(sellToken);
      expect(order.buyToken).to.deep.equal(toToken.address);
      expect(order.sellAmount).to.deep.equal(sellAmount);
      expect(order.buyAmount).to.deep.equal(buyAmount);
      expect(order.feeAmount).to.deep.equal(feeAmount);
      expect(order.kind).to.deep.equal(OrderKind.SELL);
      expect(order.receiver).to.deep.equal(receiver.address);
      // leave a minute of margin to account for the fact that the actual
      // time and the time at which they are compared are slightly different
      expect(
        Math.abs(timestamp(order.validTo) - (Date.now() / 1000 + validity)) <
          60,
      ).to.be.true;
      expect(order.partiallyFillable).to.equal(false);
    }
    api.placeOrder = async function ({ order }: PlaceOrderQuery) {
      switch (order.sellToken) {
        case usdc.address: {
          assertGoodOrder(
            order,
            usdc.address,
            usdcBalanceMinusLeftover.sub(usdcFeeAndQuote.feeAmount),
            usdcFeeAndQuote.buyAmountAfterFee,
            usdcFeeAndQuote.feeAmount,
          );
          return "0xusdcOrderUid";
        }
        case weth.address: {
          assertGoodOrder(
            order,
            weth.address,
            wethBalanceMinusLeftover.sub(wethFeeAndQuote.feeAmount),
            wethFeeAndQuote.buyAmountAfterFee,
            wethFeeAndQuote.feeAmount,
          );
          return "0xwethOrderUid";
        }
        default:
          throw new Error(
            `Invalid sell token ${order.sellToken} in mock order`,
          );
      }
    };

    const updatedState = await withdrawService.withdrawAndDump({
      state: initalState,
      solver,
      receiver: receiver.address,
      authenticator,
      settlement,
      settlementDeploymentBlock: 0,
      latestBlock: await ethers.provider.getBlockNumber(),
      minValue,
      leftover,
      validity,
      maxFeePercent,
      toToken: toToken.address,
      // ignore network value
      network: (undefined as unknown) as SupportedNetwork,
      usdReference,
      hre,
      api,
      dryRun: false,
    });

    expect(
      await usdc.allowance(solver.address, allowanceManager.address),
    ).to.equal(constants.MaxUint256);
    expect(
      await weth.allowance(solver.address, allowanceManager.address),
    ).to.equal(constants.MaxUint256);
    // note: dai is not traded as fees are too high
    expect(
      await dai.allowance(solver.address, allowanceManager.address),
    ).to.equal(constants.Zero);

    expect(updatedState.lastUpdateBlock).not.to.equal(
      initalState.lastUpdateBlock,
    );
    // there are only three tokens, so the next token to trade is again the one
    // we started with
    expect(updatedState.nextTokenToTrade).to.equal(
      initalState.nextTokenToTrade,
    );
    expect(updatedState.tradedTokens).to.have.length(3);
    expect(
      [usdc, dai, weth].filter(
        (t) => !updatedState.tradedTokens.includes(t.address),
      ),
    ).to.be.empty;
    expect(updatedState.pendingTokens).to.have.length(3);
    // this is the fourth retry for dai, the number of retries should be updated
    expect(updatedState.pendingTokens).to.deep.include({
      address: dai.address,
      retries: 4,
    });
    // the other two start their counter from one, including usdc which was
    // present in the initial state but was already withdrawn
    expect(updatedState.pendingTokens).to.deep.include({
      address: usdc.address,
      retries: 1,
    });
    expect(updatedState.pendingTokens).to.deep.include({
      address: weth.address,
      retries: 1,
    });
  });
});
// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Helper} from "test/GPv2Settlement/Helper.sol";

address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

contract ForkedTest is Helper {
    uint256 forkId;
    address vaultRelayer;

    function setUp() public virtual override {
        super.setUp();

        uint256 blockNumber = vm.envUint("FORK_BLOCK_NUMBER");
        string memory forkUrl = vm.envString("FORK_URL");
        forkId = vm.createSelectFork(forkUrl, blockNumber);

        // clear the mock revert on vault address
        vm.clearMockedCalls();
        // set the code on vault to that of actual balancer vault code
        vm.etch(address(vault), BALANCER_VAULT.code);

        // set vault relayer
        vaultRelayer = address(settlement.vaultRelayer());
    }
}

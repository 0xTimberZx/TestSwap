#!/bin/bash
cd /contracts
solc --version 2>&1
solc SegmentBoard.sol --allow-paths "." --combined-json abi,bin,storage-layout 2>&1 | head -200

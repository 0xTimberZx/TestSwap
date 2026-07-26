#!/bin/bash
solc --version
solc /contracts/SegmentBoard.sol --allow-paths "." 2>&1 | head -100

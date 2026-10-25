#!/bin/bash
# The reward is 1 when /app/hello.txt says hello.
if [ "$(tr -d '[:space:]' < /app/hello.txt 2>/dev/null)" = "hello" ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi

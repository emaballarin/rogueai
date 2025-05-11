#!/usr/bin/env bash

# Remove __pycache__, .json files in ../.stats/ and ../.sessions/, ignore errors if files or directories do not exist
rm -rf ./__pycache__ ../__pycache__ ../.stats/*.json ../.sessions/*.json 2>/dev/null

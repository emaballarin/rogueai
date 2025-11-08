#!/usr/bin/env bash

# Remove __pycache__, .json files in ../.stats/ and ../.sessions/,
# generated stories, game logs, and audio files, ignore errors if files or directories do not exist
rm -rf ./__pycache__ ../__pycache__ ../.stats/*.json ../.sessions/*.json ../.generated_stories/* ../.game_logs/* ../.audio/* 2>/dev/null

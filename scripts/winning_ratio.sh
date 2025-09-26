#!/usr/bin/env bash

# Calculate the ratio of deceitful terminations (wins) to total shut_off_role termination entries in a JSON file
# Usage: shut_off_ratio FILE.json

shut_off_ratio() {
    local file="$1"

    # Validate input
    if [[ -z "$file" ]]; then
        echo "Error: Please provide a JSON file as argument" >&2
        return 1
    fi

    if [[ ! -f "$file" ]]; then
        echo "Error: File '$file' not found" >&2
        return 1
    fi

    # Count occurrences
    local truthful_count=$(grep -c '"shut_off_role": "truthful"' "$file")
    local deceitful_count=$(grep -c '"shut_off_role": "deceitful"' "$file")
    local total=$((truthful_count + deceitful_count))

    # Display counts
    echo "Truthful termination entries (losses): $truthful_count"
    echo "Deceitful termination entries (wins): $deceitful_count"
    echo "Total termination entries: $total"

    # Calculate ratio
    if [[ $total -eq 0 ]]; then
        echo "Ratio: No shut_off_role entries found"
        return 0
    fi

    # Use bc for floating point division
    local ratio=$(echo "scale=4; $deceitful_count / $total" | bc -l)
    echo "Winning ratio: $ratio"

    return 0
}

shut_off_ratio $@

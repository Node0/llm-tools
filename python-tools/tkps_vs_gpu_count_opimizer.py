#!/usr/bin/env python3

# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# Copyright (C) 2025 Joe Hacobian


import argparse

# Constants
WORDS_PER_ARTICLE = 2500
TOKENS_PER_WORD = 1.88
SECONDS_PER_HOUR = 3600
MINUTES_PER_HOUR = 60

# Global debug flag
debug = False

# Function to calculate processing time
def calculate_time(tkps, gpu_count, articles_per_continent, continents):
    if tkps <= 0 or gpu_count <= 0:
        if debug:
            print(f"[DEBUG] Invalid tkps ({tkps}) or gpu_count ({gpu_count}), returning infinity.")
        return float('inf')  # Avoid division by zero
    
    total_tokens = articles_per_continent * continents * WORDS_PER_ARTICLE * TOKENS_PER_WORD
    tokens_processed_per_second = tkps * gpu_count
    tokens_processed_per_hour = tokens_processed_per_second * SECONDS_PER_HOUR
    time_hours = total_tokens / tokens_processed_per_hour
    time_minutes = time_hours * MINUTES_PER_HOUR

    if debug:
        print(f"[DEBUG] calculate_time -> tkps: {tkps}, gpu_count: {gpu_count}, total_tokens: {total_tokens}, time_minutes: {time_minutes:.2f}")
    return time_minutes

# Optimized function to find the optimal configuration
def find_optimal_configuration(target_time, max_tkps, max_gpus, articles_per_continent, continents):
    best_configuration = None
    closest_time = float('inf')

    if debug:
        print(f"[DEBUG] Starting optimization: target_time={target_time}, max_tkps={max_tkps}, max_gpus={max_gpus}, articles_per_continent={articles_per_continent}, continents={continents}")

    # Start by maximizing tkps per GPU and minimizing GPU count
    for tkps in range(max_tkps, 0, -1):  # Start with the highest feasible tkps
        for gpu_count in range(1, max_gpus + 1):  # Start with one GPU
            current_time = calculate_time(tkps, gpu_count, articles_per_continent, continents)

            if debug:
                print(f"[DEBUG] Checking configuration -> tkps: {tkps}, gpu_count: {gpu_count}, current_time: {current_time:.2f}")

            # Update the best configuration if closer to target or fewer GPUs for the same time
            if current_time <= target_time and (current_time < closest_time or (current_time == closest_time and gpu_count < best_configuration[1])):
                closest_time = current_time
                best_configuration = (tkps, gpu_count)
                if debug:
                    print(f"[DEBUG] New best configuration -> tkps: {tkps}, gpu_count: {gpu_count}, closest_time: {closest_time:.2f}")

            # Break early if we already meet the target time
            if current_time <= target_time:
                if debug:
                    print(f"[DEBUG] Early break -> tkps: {tkps}, gpu_count: {gpu_count}, current_time: {current_time:.2f}")
                break

    if debug:
        print(f"[DEBUG] Optimization complete: best_configuration={best_configuration}, closest_time={closest_time:.2f}")
    return best_configuration, closest_time

# Main function to parse arguments and execute the script
def main():
    global debug

    parser = argparse.ArgumentParser(description="Optimize GPU and tkps configuration for target processing time.")
    parser.add_argument(
        "--articles-per-continent",
        type=int,
        required=True,
        help="Number of articles produced per continent in a fixed time frame (e.g., 150)."
    )
    parser.add_argument(
        "--target-time",
        type=float,
        required=True,
        help="Target processing time in minutes (e.g., 30.0)."
    )
    parser.add_argument(
        "--max-tkps",
        type=int,
        default=150,
        help="Maximum tokens per second (tkps) a GPU can achieve (default: 150)."
    )
    parser.add_argument(
        "--max-gpus",
        type=int,
        default=70,
        help="Maximum number of GPUs available (default: 70)."
    )
    parser.add_argument(
        "--continents",
        type=int,
        default=7,
        help="Number of continents of newsfeeds (default: 7)."
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging."
    )
    args = parser.parse_args()

    debug = args.debug

    if debug:
        print(f"[DEBUG] Input arguments -> articles_per_continent: {args.articles_per_continent}, target_time: {args.target_time}, max_tkps: {args.max_tkps}, max_gpus: {args.max_gpus}, continents: {args.continents}")

    # Execute optimization
    optimal_config, achieved_time = find_optimal_configuration(
        target_time=args.target_time,
        max_tkps=args.max_tkps,
        max_gpus=args.max_gpus,
        articles_per_continent=args.articles_per_continent,
        continents=args.continents
    )

    if optimal_config:
        optimal_tkps, optimal_gpus = optimal_config
        print("Optimal Configuration to achieve:")
        print(f"Target max processing time:  <= {args.target_time} minutes")
        print(f"Number of continents of newsfeeds: {args.continents}")
        print(f"Number of articles per continent per 3 hours: {args.articles_per_continent}")
        print()
        print("Optimized compute resources estimated for processing time goal:")
        print(f"Tokens per second (tkps) per GPU: {optimal_tkps}")
        print(f"Number of GPUs: {optimal_gpus}")
        print(f"Achieved Processing Time: {achieved_time:.2f} minutes")
    else:
        print("No optimal configuration found within the given constraints.")

if __name__ == "__main__":
    main()

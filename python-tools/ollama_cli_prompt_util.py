#!/usr/bin/env python3

import argparse
import json
import http.client
import sys

def list_models(hostname, port):
    """List available models from the Ollama server."""
    endpoint = "/api/tags"  # Correct endpoint for listing local models
    connection = http.client.HTTPConnection(hostname, port)
    try:
        connection.request("GET", endpoint)
        response = connection.getresponse()

        if response.status != 200:
            print(f"Error: HTTP {response.status} - {response.reason}")
            return

        data = json.loads(response.read().decode("utf-8"))
        models = data.get("models", [])

        print("Available Models:\n")
        for model in models:
            name = model.get("name", "Unknown")
            size = model.get("size", 0)
            modified_at = model.get("modified_at", "Unknown")
            details = model.get("details", {})
            parameter_size = details.get("parameter_size", "Unknown")
            quantization = details.get("quantization_level", "Unknown")
            format_ = details.get("format", "Unknown")

            # Display model information
            print(f"Name: {name}")
            print(f"  Size: {size / 1_000_000_000:.2f} GB")  # Convert bytes to GB
            print(f"  Modified At: {modified_at}")
            print(f"  Parameters: {parameter_size}")
            print(f"  Quantization Level: {quantization}")
            print(f"  Format: {format_}")
            print("-" * 40)

    finally:
        connection.close()


def stream_ollama_response(hostname, port, model, prompt, system_prompt, temperature, max_tokens):
    """Stream responses from the Ollama server."""
    endpoint = "/api/generate"
    headers = {"Content-Type": "application/json"}
    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "system": system_prompt,
        "temperature": temperature,
        "max_tokens": max_tokens
    })

    connection = http.client.HTTPConnection(hostname, port)
    try:
        connection.request("POST", endpoint, body=payload, headers=headers)
        response = connection.getresponse()

        if response.status != 200:
            print(f"Error: HTTP {response.status} - {response.reason}")
            return

        concatenated_response = ""
        for line in response:
            line = line.decode("utf-8").strip()
            if line:
                try:
                    response_data = json.loads(line)
                    word = response_data.get("response", "")
                    concatenated_response += word
                    print(word, end="", flush=True)
                except json.JSONDecodeError:
                    print(f"\nInvalid JSON: {line}")

        print("\n\nFinal Response:")
        print(concatenated_response)

    finally:
        connection.close()

def main():
    parser = argparse.ArgumentParser(description="Interact with Ollama server.")
    parser.add_argument("--ollama-hostname", required=True, help="Hostname of the Ollama server")
    parser.add_argument("--ollama-port", type=int, required=True, help="Port number of the Ollama server")

    # Mutually exclusive arguments
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list-models", action="store_true", 
                       help="List all available models on the Ollama server")
    group.add_argument("--model", help="Specify the model to use")

    # Other arguments
    parser.add_argument("--prompt", help="Prompt to send to the Ollama server")
    parser.add_argument("--system-prompt", default="You are a helpful assistant.", 
                        help="System prompt to define the model's behavior")
    parser.add_argument("--temperature", type=float, default=0.7, 
                        help="Temperature for response randomness")
    parser.add_argument("--max-tokens", type=int, default=100, 
                        help="Maximum number of tokens to generate")

    args = parser.parse_args()

    # If --list-models is specified, list models and exit
    if args.list_models:
        list_models(args.ollama_hostname, args.ollama_port)
        return

    # Validate other required arguments
    if not args.prompt:
        print("Error: --prompt is required when --list-models is not specified.")
        sys.exit(1)

    if not args.model:
        print("Error: --model is required when --list-models is not specified.")
        sys.exit(1)

    # Stream response from the server
    stream_ollama_response(
        args.ollama_hostname,
        args.ollama_port,
        args.model,
        args.prompt,
        args.system_prompt,
        args.temperature,
        args.max_tokens
    )

if __name__ == "__main__":
    main()


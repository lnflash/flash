#!/bin/bash
# This script generates a YAML file containing user-defined application secrets

OUTPUT_FILE="$CONFIG_PATH/dev-overrides.yaml"

mkdir -p "$(dirname "$OUTPUT_FILE")"

# Define YAML paths and their descriptions directly in the script
declare -a yaml_paths=(
  "ibex.email, Email address to Ibex Account"
  "ibex.password, Password to Ibex Account"
  "ibex.webhook.uri, The URI where Ibex will send payment events"
  "mailgun.apiKey, API key to Mailgun email service"
  "mailgun.domain, Domain associated with the Mailgun account"
  "cashout.email.to, Recipient email address for cashout notifications"
)

# Function to write YAML paths to the output file
write_yaml() {
  local path="$1"
  local value="$2"
  local indent=""
  local IFS="."

  # Split the path into keys
  read -ra keys <<< "$path"

  # Track written parent keys
  local current_path=""
  for ((i = 0; i < ${#keys[@]}; i++)); do
    key="${keys[i]}"
    current_path="${current_path}${key}."

    if ((i == ${#keys[@]} - 1)); then
      # Last key, write the value
      echo "${indent}${key}: \"$value\"" >> "$OUTPUT_FILE"
    else
      # Intermediate key, write only if not already written
      if [[ ! " ${written_keys[@]} " =~ " ${current_path} " ]]; then
        echo "${indent}${key}:" >> "$OUTPUT_FILE"
        written_keys+=("$current_path")
      fi
      indent+="  "
    fi
  done
}

# Iterate over the YAML paths and descriptions
for entry in "${yaml_paths[@]}"; do
  # Split the entry into path and description
  IFS=',' read -r path description <<< "$entry"

  # Prompt the user for the value of the current path
  echo -n "Enter value for $path ($description): "
  read -r value

  # Write the path and value to the output YAML file
  write_yaml "$path" "$value"
done

echo "YAML file has been written to $OUTPUT_FILE."
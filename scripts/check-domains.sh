#!/bin/bash
# Batch .com availability checker. Usage: check-domains.sh <file-with-one-name-per-line>
# Prints "AVAILABLE name.com" or "taken name.com". Names may omit the .com suffix.
while IFS= read -r name; do
  name=$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr -d ' \r')
  [ -z "$name" ] && continue
  case "$name" in \#*) continue;; esac
  domain="${name%.com}.com"
  result=$(whois -h whois.verisign-grs.com "domain $domain" 2>&1)
  if echo "$result" | grep -qi "No match for"; then
    echo "AVAILABLE $domain"
  elif echo "$result" | grep -qi "Domain Name:"; then
    echo "taken    $domain"
  else
    echo "ERROR    $domain"
  fi
  sleep 0.35
done < "$1"

#!/bin/bash

docker compose up frappe -d

echo "Login to http://frontend.local:8080/#login"
echo "Username: Administrator" 
echo "Password: admin"
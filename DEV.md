# Dev environment

- [Dev environment](#dev-environment)
  - [Setup](#setup)
    - [Runtime dependencies](#runtime-dependencies)
  - [Development](#development)
    - [Config](#config)
    - [Using GraphQL Playground](#using-graphql-playground)
    - [Honeycomb](#honeycomb)
    - [Docker compose](#docker-compose)
  - [Testing](#testing)
    - [Run unit tests](#run-unit-tests)
    - [Run integration tests](#run-integration-tests)
    - [Run specific test file](#run-specific-test-file)
      - [Unit](#unit)
      - [Integration](#integration)
  - [Migrations](#migrations)
    - [Testing migrations](#testing-migrations)
      - [Create a new migration](#create-a-new-migration)
    - [Known issues](#known-issues)
  - [Running checks](#running-checks)
  - [Contributing](#contributing)

## Setup

This setup was last tested with the following tools:

```
$ node --version
v20.10.0
$ yarn --version
1.22.21
$ direnv --version
2.28.0
$ jq --version
jq-1.6
$ docker --version
Docker version 20.10.8, build f0df350
$ docker compose version
Docker Compose version 2.0.0
```

To use the correct node version, you can install nvm and run `nvm use 20`. Then enable and inititialize yarn using the [yarn docs](https://yarnpkg.com/getting-started/install)

### Clone the repo:

```
$ git clone git@github.com:lnflash/flash.git
$ cd flash
```

*Flash is a fork of [Blink](https://github.com/GaloyMoney/blink) at commit `0a52b0673` (tag: 0.13.92)*

### Set the Environment 

[direnv](https://direnv.net) is required to load environment variables. Make sure it is installed and that the [direnv hook](https://direnv.net/docs/hook.html) is added to your `shell.rc` file.

Create a `.env.local` to add local environment overrides. For the Flash project, the IBEX_PASSWORD is required. E.g: 

 `echo "export IBEX_EMAIL='<insert-email>'" >> .env.local`
 `echo "export IBEX_PASSWORD='<insert-password>'" >> .env.local`

Make sure to allow direnv and reload:

```
$ direnv allow
$ direnv reload
(...)
```

### Configure the app

A base configuration for development purposes is provided in the `./dev/defaults.yaml` file. This file does excludes some values which are kept out of source control (e.g secrets). To add these values, you can either:

1. Copy an existing overrides file to the `$CONFIG_PATH/dev-overrides.yaml`, or:
2. Run the `set-overrides.sh` script which will generate the `dev-overrides.yaml` with user-defined values.
```
chmod +x ./dev/set-overrides.sh
./dev/set-overrides.sh
```

#### Configure ErpNext

Flash uses Frappe's ErpNext application for accounting purposes. 

By default, the development configuration uses the Frappe Bench server running in the (Flash test environment)[https://erp.test.flashapp.me]. You may need to update your yaml config with proper credentials and account information.

When testing and developing features, it is recommended to run the Frappe Bench server locally. [See here](https://github.com/frappe/bench) for installation instructions. Once the server is running, update your FrappeConfig set in the dev yamls. 

#### Testing the ibex-webhook

You'll need a web gateway that forwards traffic to your local server (default http://localhost:4008). This can be done with Ngrok. After installing the ngrok cli and creating an account, do the following:

1. Start ngrok tunnel:
   
   ```
   ngrok http http://localhost:4008
   ```

2. Copy the provided URL ("forwarding" field)

3. Add the URL to your `$CONFIG_PATH/dev-overrides.yaml` environment variable. E.g
   
   Note: To avoid repeating steps 2 & 3 everytime you restart the web gateway, you can get a static domain (e.g [ngrok domains](https://dashboard.ngrok.com/cloud-edge/domains))

### Install dependencies

```
$ yarn install
```

### Start the runtime dependencies

```bash
$ make start-deps
# or
$ make reset-deps
```

Everytime the dependencies are re-started the environment must be reloaded via `direnv reload`. When using the [make command](../Makefile) this will happen automatically.

## Development

To start the GraphQL server and its dependencies:

```
$ make start
```

To run in debug mode:

```
DEBUG=* make start
```

After running `make start-deps` or `make reset-deps`, the lightning network - running on regtest - will not have any channel, and the mongodb database - that includes some mandatory accounts for Galoy to work - will be empty.

You can then login with the following credentials to get an account with an existing balance: `phone: +16505554328`, `code: 000000`

### Using GraphQL Playground

You can load the Apollo GraphQL Playground, a web GUI for GraphQL. Start the server and open the following url:

- http://localhost:4002/admin/graphql (admin API, proxied thru oathkeeper)
- http://localhost:4002/graphql (end user API, proxied thru oathkeeper)

### Honeycomb

To test the effect of a change on open telemetry locally, `HONEYCOMB_API_KEY` and `HONEYCOMB_DATASET` values needs to be set.

`HONEYCOMB_API_KEY` can be found in Account > Team settings > Environments and API Keys > Manage > copy the dev key
`HONEYCOMB_DATASET` can be any string, pick something like `myusername-dev`

### Docker compose

The docker compose files are split into `docker-compose.yml` and `docker-compose.override.yml`.

By default, with `docker compose up`, docker will merge both files. The `docker-compose.override.yml` will expose ports on your host machine to various containers.

During CI testing we ignore the override file in order to contain tests within a docker network. This is achieved by specifically calling out the docker compose file to use ex: `docker compose -f docker-compose.yml up`.

## Testing

To run the full test suite you can run:

```bash
$ make test
```

Executing the full test suite requires [runtime dependencies](#runtime-dependencies).

### Run unit tests

```bash
$ yarn test:unit
# or
$ make unit
```

Runtime dependencies are not required for unit tests

### Run integration tests

To execute the integration tests [runtime dependencies](#runtime-dependencies) must be running.

```bash
$ yarn test:integration
# or
$ make integration
```

The  integration tests are *not* fully idempotent (yet) so currently to re-run the tests, run:

```
$ make reset-integration
```

### Run specific test file

To execute a specific test file:

#### Unit

Example to run `test/unit/config.spec.ts`

```bash
$ TEST=utils yarn test:unit
# or
$ TEST=utils make unit
```

where `utils` is the name of the file `utils.spec.ts`

#### Integration

Example to run `test/integration/01-setup/01-connection.spec.ts`

```bash
$ TEST=01-connection yarn test:integration
# or
$ TEST=01-connection make integration
```

if within a specific test suite you want to run/debug only a describe or it(test) block please use:

* [describe.only](https://jestjs.io/docs/api#describeonlyname-fn): just for debug purposes
* [it.only](https://jestjs.io/docs/api#testonlyname-fn-timeout): just for debug purposes
* [it.skip](https://jestjs.io/docs/api#testskipname-fn): use it when a test is temporarily broken. Please don't commit commented test cases

## Migrations

### Testing migrations

Migrations are stored in the `src/migrations` folder.
When developing migrations the best way to test them on a clean database is:

```
make test-migrate
```

#### Create a new migration

Create the migration file

```bash
npx migrate-mongo create <migration-name> \
  -f src/migrations/migrate-mongo-config.js
```

Write the migration in the newly created migration file and then test/run with the following:

```bash
# Migrate
npx migrate-mongo up \
  -f src/migrations/migrate-mongo-config.js

# Rollback
npx migrate-mongo down \
  -f src/migrations/migrate-mongo-config.js
```

When testing, to isolate just the current migration being worked on in local dev you can temporarily move the other migrations to another dir.

### Known issues

* **Test suite timeouts**: increase jest timeout value. Example:
  
  ```bash
  # 120 seconds
  $ JEST_TIMEOUT=120000 yarn test:integration
  ```

* **Integration tests running slow**: we use docker to run dependencies (redis, mongodb, bitcoind and 4 lnds) so the entire test suite is disk-intensive.
  
  * Please make sure that you are running docker containers in a solid state drive (SSD)
  
  * Reduce lnd log disk usage: change debuglevel to critical
    
    ```
    # ./dev/lnd/lnd.conf
    debuglevel=critical
    ```

## Running checks

It's recommended that you use plugins in your editor to run ESLint checks and perform Prettier formatting on-save.

To run all the checks required for the code to pass GitHub actions check:

```
$ make check-code
(...)
$ echo $?
0
```

If you need to run Prettier through the command line, you can use:

```
$ yarn prettier -w .
```

## Contributing

See the [CONTRIBUTING.md](./CONTRIBUTING.md)

Tests have been split between legacy Galoy code and newer Flash code. The `../package.json` has been updated to run the tests in the `./flash` directory. These tests should run on every merge to `main`. Moving forward, we want to continue migrating useful tests to the [flash](test/flash) directory
### Public username directory checks

The username search suite uses the production Account schema and existing username
index against a dedicated MongoDB 6.0 database. It checks strangers, typo/prefix
matching, visibility filters, result limits, and actual query plans (IXSCAN,
without COLLSCAN). CI runs it in a separate MongoDB service.

With the normal test environment loaded and a disposable local MongoDB instance:

```sh
USERNAME_SEARCH_TEST_URI=mongodb://127.0.0.1:27017/username_search_test \
  yarn jest --config test/flash/username-search.config.cjs --runInBand
```

The URI must use a loopback host and name `username_search_test`; setup also checks
the driver's actual database name. The suite drops that database
before and after its checks; never point it at an application database.

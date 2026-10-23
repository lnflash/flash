const base = require("./unit/jest.config")
module.exports = {
  ...base,
  rootDir: "../../",
  roots: ["<rootDir>/test/flash/username-search"],
}

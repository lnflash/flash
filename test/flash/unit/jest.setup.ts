
// Set yaml configurations 
jest.mock("yargs", () => {
  const yargsMock = {
    option: jest.fn().mockReturnThis(),
    argv: {
      configPath: ["./dev/config.yaml", "./dev/overrides.yaml"],
    },
  };
  return jest.fn(() => yargsMock);
});
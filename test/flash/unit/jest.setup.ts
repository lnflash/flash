
// Set yaml configurations 
jest.mock("yargs", () => {
  const yargsMock = {
    option: jest.fn().mockReturnThis(),
    argv: {
      configPath: [
        "./dev/config/base-config.yaml", 
      ],
    },
  };
  return jest.fn(() => yargsMock);
});
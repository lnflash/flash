
// Set yaml configurations 
jest.mock("yargs", () => {
  const yargsMock = {
    option: jest.fn().mockReturnThis(),
    argv: {
      configPath: [
        "./dev/defaults.yaml", 
      ],
    },
  };
  return jest.fn(() => yargsMock);
});
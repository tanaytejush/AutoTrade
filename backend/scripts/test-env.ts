process.env.PAPER_TRADING = "true";

process.on("exit", () => {
  delete process.env.PAPER_TRADING;
});

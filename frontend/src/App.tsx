import { useEffect, useState } from "react";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

function App() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;

    const checkHealth = async () => {
      try {
        const response = await fetch(`${apiUrl}/health`);
        if (active) {
          setConnected(response.ok);
        }
      } catch {
        if (active) {
          setConnected(false);
        }
      }
    };

    void checkHealth();
    const interval = window.setInterval(checkHealth, 5000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return <main>Backend status: {connected ? "connected" : "disconnected"}</main>;
}

export default App;

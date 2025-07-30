[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/valyu-network-valyu-mcp-badge.png)](https://mseep.ai/app/valyu-network-valyu-mcp)

# Valyu MCP Server

The Valyu MCP Server is a Model Context Protocol (MCP) tool that enables AI models to retrieve high-quality context from Valyu's API, including full search capabilities over Wikipedia, arXiv papers (great for finance, research, etc.), and web search.

## Prerequisites

Before setting up the MCP server, ensure you have the following:

1. **Python 3.10+**
2. **Claude Desktop (latest version)**
3. **Valyu API Key** (Get one from [Valyu Exchange](https://exchange.valyu.network))

To check your Python version, run:

```bash
python --version
```

## Installation & Configuration

### Option 1: Automated Setup (Recommended)

1. **Clone the repository**

```bash
git clone https://github.com/ValyuNetwork/valyu-mcp.git
cd valyu-mcp
```

2. **Run the setup script**

```bash
chmod +x setup.sh  
./setup.sh       
```

The setup script will:

- Create and activate a virtual environment
- Install all dependencies
- Prompt you for your Valyu API key
- Create the necessary .env file
- Provide instructions for updating your Claude Desktop configuration

### Option 2: Manual Setup

If you prefer to set up manually or the automated setup doesn't work for your environment, follow these steps:

1. **Clone the repository**

```bash
git clone https://github.com/ValyuNetwork/valyu-mcp.git
cd valyu-mcp
```

2. **Create a virtual environment and activate it**

```bash
python -m venv .venv
source .venv/bin/activate  # macOS/Linux
.venv\Scripts\activate    # Windows
```

3. **Install dependencies**

```bash
pip install -r requirements.txt
```

4. **Create a `.env` file in the project root:**

```bash
echo "VALYU_API_KEY=your-api-key-here" > .env
```

5. **Open your Claude Desktop config file for editing:**

   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

   If the config file doesn't exist:

   1. Open Claude Desktop
   2. Go to Settings
   3. Enable Developer Mode in the Developer tab
   4. The config file will be generated automatically

   You can open this file in VS Code using:

   ```bash
   code ~/Library/Application\ Support/Claude/claude_desktop_config.json  # macOS
   code %APPDATA%\Claude\claude_desktop_config.json  # Windows (PowerShell)
   ```

6. **Add the following entry under `mcpServers`:**

```json
{
  "mcpServers": {
    "valyu-mcp": {
      "command": "/ABSOLUTE/PATH/TO/.venv/bin/python",
      "args": ["-u", "/ABSOLUTE/PATH/TO/valyu-mcp.py"],
      "env": {
        "VALYU_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Running the MCP Server

1. **Start the server manually (for testing):**

```bash
python valyu-mcp.py
```

2. **Start Claude Desktop and verify the MCP tool is recognized:**
   - Look for the `valyu-mcp` tool in the Claude interface.
   - Test a query in Claude (e.g., _"What are the latest papers on reinforcement learning?")_.

## Testing and Debugging

Check logs if you encounter issues:

```bash
tail -n 20 -F ~/Library/Logs/Claude/mcp*.log  # macOS
```

```powershell
Get-Content $env:APPDATA\Claude\Logs\mcp_valyu-mcp.log -Wait  # Windows
```

## Troubleshooting

- **`ModuleNotFoundError`**: Ensure your virtual environment is activated before running the script.
- **Server doesn't start**: Check paths in `claude_desktop_config.json`.
- **No results from Valyu API**: Verify your API key is valid and has credits.

## Free Credits & API Access

Sign up at [Valyu Exchange](https://exchange.valyu.network) and claim your **$10 free credits** to test Valyu API with the MCP server.

## Contributing

Pull requests are welcome! Feel free to open an issue for bug reports or feature requests.

## License

This project is licensed under the MIT License.

---

For more information about what we are building at Valyu, visit [valyu.network](https://www.valyu.network).
And check out our blogs at [valyu.network/blog](https://valyu.network/blog).

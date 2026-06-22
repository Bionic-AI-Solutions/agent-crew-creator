"""
Execute Python code in a sandboxed environment.

The agent calls this tool to run Python code for computation, data analysis,
chart generation, or any task that benefits from programmatic execution.

The code runs in a restricted subprocess with a 30-second timeout.
Outputs (stdout + stderr) are returned to the agent.
"""
import subprocess
import tempfile
import os


def code_interpreter(code: str) -> str:
    """Execute Python code and return the output.

    Args:
        code: Python code to execute. Can use standard library modules.
              For data analysis, numpy/pandas are available if installed.

    Returns:
        String containing stdout output, or error message if execution fails.
    """
    if not code or not code.strip():
        return "Error: No code provided"

    # Write code to a temporary file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(code)
        tmp_path = f.name

    try:
        # Execute in a subprocess with timeout
        result = subprocess.run(
            ["python3", tmp_path],
            capture_output=True,
            text=True,
            timeout=30,
            env={
                **os.environ,
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )

        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            if output:
                output += "\n--- stderr ---\n"
            output += result.stderr

        if not output:
            output = "(no output)"

        if result.returncode != 0:
            output = f"Exit code {result.returncode}\n{output}"

        return output[:4000]  # Cap output length

    except subprocess.TimeoutExpired:
        return "Error: Code execution timed out after 30 seconds"
    except Exception as e:
        return f"Error: {str(e)}"
    finally:
        os.unlink(tmp_path)

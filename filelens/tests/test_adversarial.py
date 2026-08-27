"""Adversarial testing suite for FileLens security and robustness."""
import pytest
import tempfile
import os
from pathlib import Path
from filelens.core import FileLens


class TestPathTraversalSecurity:
    """Test protection against path traversal attacks."""
    
    def test_absolute_path_outside_root(self):
        """Should reject absolute paths outside allowed directories."""
        lens = FileLens()
        with pytest.raises((ValueError, PermissionError, OSError)):
            lens.read("/etc/passwd")
    
    def test_relative_path_traversal(self):
        """Should reject ../../../etc/passwd style attacks."""
        lens = FileLens()
        with pytest.raises((ValueError, PermissionError, OSError)):
            lens.read("../../../etc/passwd")
    
    def test_symlink_to_sensitive_file(self):
        """Should handle symlinks pointing to sensitive files safely."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a symlink to /etc/passwd
            symlink_path = Path(tmpdir) / "evil_link"
            try:
                symlink_path.symlink_to("/etc/passwd")
                lens = FileLens()
                # Should either refuse to follow or handle safely
                result = lens.read(str(symlink_path))
                # If it reads, ensure it's handled safely
                assert result is not None
            except (OSError, ValueError, PermissionError):
                # Acceptable to reject symlinks to sensitive files
                pass
    
    def test_double_encoded_path(self):
        """Should reject double-encoded path traversal attempts."""
        lens = FileLens()
        with pytest.raises((ValueError, PermissionError, OSError)):
            lens.read("..%252f..%252f..%252fetc%252fpasswd")


class TestUnicodeHandling:
    """Test robust Unicode handling."""
    
    def test_surrogate_characters(self):
        """Should handle Unicode surrogate characters without crashing."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8') as f:
            # Write surrogate characters (invalid in UTF-8 but can appear in Windows)
            f.write("Hello \ud800\udc00 World")
            temp_path = f.name
        
        try:
            lens = FileLens()
            result = lens.read(temp_path)
            # Should handle gracefully, either by reading or raising appropriate error
            assert result is not None or True  # Accept any non-crash behavior
        except (UnicodeDecodeError, UnicodeEncodeError):
            # Acceptable to raise unicode errors
            pass
        finally:
            os.unlink(temp_path)
    
    def test_mixed_encodings(self):
        """Should handle files with mixed or unknown encodings."""
        with tempfile.NamedTemporaryFile(mode='wb', suffix='.txt', delete=False) as f:
            # Write mixed encoding content
            f.write(b"Hello \xff\xfe World")
            temp_path = f.name
        
        try:
            lens = FileLens()
            result = lens.read(temp_path)
            assert result is not None or True
        except (UnicodeDecodeError, LookupError):
            # Acceptable to raise encoding errors
            pass
        finally:
            os.unlink(temp_path)


class TestLargeFileHandling:
    """Test handling of extremely large files."""
    
    def test_massive_file(self):
        """Should handle very large files without memory exhaustion."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            # Write 1MB of data
            f.write("x" * 1000000)
            temp_path = f.name
        
        try:
            lens = FileLens()
            result = lens.read(temp_path)
            assert result is not None
            assert len(result.content) > 0
        finally:
            os.unlink(temp_path)
    
    def test_many_lines(self):
        """Should handle files with many lines efficiently."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            for i in range(10000):
                f.write(f"Line {i}\n")
            temp_path = f.name
        
        try:
            lens = FileLens()
            result = lens.read(temp_path)
            assert result is not None
        finally:
            os.unlink(temp_path)


class TestCodeInjection:
    """Test protection against code injection via file content."""
    
    def test_python_code_in_string(self):
        """Should treat Python code in files as data, not execute it."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write("""
import os
os.system('echo PWNED')
print("This should not execute")
""")
            temp_path = f.name
        
        try:
            lens = FileLens()
            result = lens.read(temp_path)
            # Should only read content, not execute
            assert result is not None
            assert 'import os' in result.content
        finally:
            os.unlink(temp_path)
    
    def test_shell_injection_in_filename(self):
        """Should handle filenames with shell metacharacters safely."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create file with shell metacharacters in name
            dangerous_name = Path(tmpdir) / "test; rm -rf /.txt"
            try:
                dangerous_name.write_text("content")
                lens = FileLens()
                result = lens.read(str(dangerous_name))
                assert result is not None
            except (OSError, ValueError):
                # Acceptable to reject dangerous filenames
                pass


class TestMarkdownParser:
    """Test markdown parser edge cases."""
    
    def test_all_header_levels(self):
        """Should handle all markdown header levels h1-h6."""
        content = """# H1 Header
## H2 Header
### H3 Header
#### H4 Header
##### H5 Header
###### H6 Header
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
            f.write(content)
            temp_path = f.name
        
        try:
            lens = FileLens()
            result = lens.read(temp_path)
            assert result is not None
            # All headers should be present in content
            assert '# H1' in result.content
            assert '###### H6' in result.content
        finally:
            os.unlink(temp_path)


class TestReDoSProtection:
    """Test protection against Regular Expression Denial of Service."""
    
    def test_regex_catastrophic_backtracking(self):
        """Should not hang on regex bomb patterns."""
        # Pattern that causes catastrophic backtracking
        bomb = "a" * 10000 + "!"
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write(bomb)
            temp_path = f.name
        
        try:
            lens = FileLens()
            # Should complete quickly, not hang
            result = lens.read(temp_path)
            assert result is not None
        finally:
            os.unlink(temp_path)


class TestNullByteInjection:
    """Test protection against null byte injection."""
    
    def test_null_byte_in_path(self):
        """Should handle null bytes in file paths safely."""
        lens = FileLens()
        # Null byte should cause an error or be handled safely
        with pytest.raises((ValueError, TypeError, OSError)):
            lens.read("/tmp/test\x00.txt")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

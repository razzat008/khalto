import re

with open('mobile-client/App.old.js', 'r') as f:
    old_content = f.read()

with open('mobile-client/App.js', 'r') as f:
    new_content = f.read()

# Extract old styles
old_styles_match = re.search(r'const styles = StyleSheet\.create\({(.*?)}\);', old_content, re.DOTALL)
if old_styles_match:
    old_styles = old_styles_match.group(1)
else:
    print("Could not find old styles")
    exit(1)

# Extract new styles (which contains the modal styles I just added)
new_styles_match = re.search(r'const styles = StyleSheet\.create\({(.*?)}\);', new_content, re.DOTALL)
if new_styles_match:
    new_styles = new_styles_match.group(1)
else:
    print("Could not find new styles")
    exit(1)

# Remove the overlapping/duplicate styles if any. Actually, just combining them is safe since new_styles starts at warnHigh.
# Let's clean it up slightly to ensure no syntax errors.
combined_styles = f"const styles = StyleSheet.create({{{old_styles},\n{new_styles}}});"

# Replace in App.js
fixed_content = re.sub(r'const styles = StyleSheet\.create\({.*?}\);', combined_styles, new_content, flags=re.DOTALL)

with open('mobile-client/App.js', 'w') as f:
    f.write(fixed_content)

print("Styles restored successfully.")

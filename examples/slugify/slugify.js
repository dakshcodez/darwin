// Turns a title into a URL slug, e.g. "Hello World" -> "hello-world".
function slugify(input) {
  return input.toLowerCase().replace(/ /g, "-");
}

module.exports = { slugify };

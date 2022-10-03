/*Copyright (C) 2019-2022 The Xanado Project https://github.com/cdot/Xanado
  License MIT. See README.md at the root of this distribution for full copyright
  and license information. Author Crawford Currie http://c-dot.co.uk*/
/* eslint-env amd, node */

define([
  "platform", "dawg/LetterNode",
], (
  Platform, LetterNode
) => {

  /**
   * Dictionary using a Directed Acyclic Word Graph (DAWG) in the
   * format generated by DAWG_Compressor.js
   *
   * Note that the DAWG uses letter indices, and not actual characters, to
   * represent code points. To use this dictionary you also need an
   * alphabet of code points sorted in the same order as that used to
   * generate the DAWG.
   */
  class Dictionary {

    /**
     * Cache of dictionaries
     * @member {Dictionary[]}
     * @private
     */
    static cache = [];

    /**
     * First node in the dictionary.
     * @member {LetterNode?}
     */
    root;

    /**
     * List of valid start points, such that at least one
     * start point must match() for any sequence of chars, or
     * there can't possibly be a word. Map from letter to a
     * LetterNode or a list of LetterNode.
     * @private
     */
    sequenceRoots;

    /**
     * @param {string} name name of the dictionary
     * It's actually an array of little-endian 4-byte integers.
     * Note that this constructor is private.
     */
    constructor(name) {
      /**
       * List of valid start points, such that at least one
       * start point must match() for any sequence of chars,
       * or there can't possibly be a word.
       * @member {string}
       */
      this.name = name;
    }

    /**
     * Load a DAG, as generated by dictionary_compressor.js. This is
     * destructive; anything already in the dictionary will be
     * discarded.
     * @param {(Buffer|Array)?} data the DAWG data.
     * @return {Dictionary} this
     * @private
     */
    loadDAWG(data) {
      const dv = new DataView(data);
      let index = 0;
      const numberOfNodes = dv.getUint32(4 * index++);
      const nodes = [];
      for (let i = 0; i < numberOfNodes; i++) {
        const letter = dv.getUint32(4 * index++);
        const node = new LetterNode(String.fromCodePoint(letter));
        node.decode(i, dv.getUint32(4 * index++));
        //console.log(`${nodes.length} `,node);
        nodes.push(node);
      }
      // Convert node indices to pointers
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (typeof node.next === "number")
          node.next = nodes[node.next];
        if (typeof node.child === "number")
          node.child = nodes[node.child];
      }
      this.root = nodes[0];

      return this;
    }

    /*
     * Cross-link nodes in the dictionary with nodes before and
     * after them, for fast traversal.
     * @return {Dictionary} this
     */
    addLinks() {
      // Build forward and back lists
      this.root.buildLists();
      return this;
    }

    /**
     * @callback Dictionary~wordCallback
     * @param {string} word Word found
     * @param {LetterNode} node Node where word was terminated
     */

    /**
     * Apply the callback to each of the words represented in the DAWG
     * (potentially huge!)
     * @param {Dictionary~wordCallback} callback function
     */
    eachWord(callback) {
      return this.root.eachWord("", callback);
    }

    /**
     * Return the LetterNode that matches the last character
     * in chars, starting from the root / first character.
     * @param {string} chars characters that may be the root of a word
     * @return {LetterNode} node found, or undefined
     */
    match(chars) {
      return this.root.match(chars, 0);
    }

    /**
     * Check if a word is in the dictionary
     * @param {string} chars a word to check
     * @return {boolean} true if the word is found, false otherwise
     */
    hasWord(chars) {
      const m = this.root.match(chars, 0);
      return m && m.isEndOfWord;
    }

    /**
     * Find anagrams of a set of letters. An anagram is defined as any
     * complete (2 or more characters) word that uses all or some of the
     * letters passed in.
     * @param {string} theChars the letters, ' ' for an any-letter wildcard.
     * @return {Object<string, string>} a map of actual words to the letter
     * sequence (using ' ' for blanks) that matched.
     */
    findAnagrams(theChars) {
      theChars = theChars.toUpperCase();

      Platform.assert(theChars.length >= 2, "Too short to find anagrams");

      // Sort the list of characters.
      // Sorting makes it easier to debug.
      const ac = theChars.split("");//.sort();

      //console.log('Sorted chars', ac);
      const foundWords = {};
      this.root.findWordsThatUse(ac, "", "", foundWords);
      return foundWords;
    }

    /**
     * For each letter of the alphabet, establish a list of valid
     * start points, such that at least one start point must match()
     * for any sequence of chars, or there can't possibly be a word.
     * @private
     */
    createSequenceRoots() {
      this.sequenceRoots = {};
      this.root.eachNode(node => {
        if (!this.sequenceRoots[node.letter])
          this.sequenceRoots[node.letter] = [node];
        else
          this.sequenceRoots[node.letter].push(node);
        return true;
      });
      //console.log(`Created sequence roots for dictionary "${this.name}"`);
    }

    /**
     * Get a list of the sequence roots for ch. The sequence roots
     * are all those nodes that represent the character in any word.
     * From a sequence root we can follow post or pre to extend the
     * word in either direction.
     */
    getSequenceRoots(ch) {
      if (!this.sequenceRoots)
        this.createSequenceRoots();
      return this.sequenceRoots[ch] || [];
    }

    /**
     * Do the work of adding a word, but don't do anything about
     * pre-/post- links or sequence roots.
     * @private
     */
    _addWord(word) {
      /* istanbul ignore if */
      if (word.length === 0)
        return false;
      if (!this.root)
        this.root = new LetterNode(word.charAt(0));
      else if (this.hasWord(word))
        return false;
      this.root.add(word);
      return true;
    }

    /**
     * Add a word to the dictionary. No attempt is made at compression.
     * Note that previously retrieved sequence roots will no longer
     * be valid after the word is added and will need to be recomputed.
     * Note that we support single character words here, but
     * word games are limited to 2 letter or more. It's up to
     * the caller to enforce such constraints.
     * @return {boolean} true if the word needed to be added, false
     * if it was empty or already there.
     */
    addWord(word) {
      if (this._addWord(word)) {
        // Don't recreate, that will be done on demand
        delete this.sequenceRoots;
        // Re-build forward and back lists. This could be done
        // incrementally, but it's a reasonably cheap operation so....
        this.root.buildLists();
        return true;
      }
      return false;
    }

    /**
     * Find start node for the character sequence in the sequence
     * index i.e. it forms a valid sub-part of a word in the
     * dictionary. This way we can quickly eliminate sequences
     * such as "QX" which are never found in the dictionary. Note
     * that we don't have any way to reproduce the words that the
     * sequence is a valid part of; that's not the point, this is
     * intended to help eliminate invalid sequences when extending
     * a word backwards from a seed letter.
     * @param {string} seq letter sequence
     * @private
     */
    findSequence(seq) {
      if (!this.sequenceRoots)
        this.createSequenceRoots();
      const roots = this.sequenceRoots[seq.charAt(0)];
      Platform.assert(roots && roots.length > 0, `'${seq}' has no roots`);
      for (let root of roots) {
        if (root.match(seq, 0))
          return root;
      }
      // Not found
      return null;
    }

    /**
     * Return true if a start node for the character sequence is found
     * in the sequence index i.e. it forms a valid sub-part of a word
     * in the dictionary. This way we can quickly eliminate sequences
     * such as "QX" which are never found in the dictionary. Note that
     * we don't have any way to reproduce the words that the sequence
     * is a valid part of; that's not the point, this is intended to help
     * eliminate invalid sequences when extending a word backwards from
     * a seed letter.
     * @param {string} seq letter sequence
     * @return {boolean} if a start node exists
     */
    hasSequence(seq) {
      return this.findSequence(seq) != null;
    }

    /**
     * Promise to load a dictionary. A dictionary can consist of a
     * `.dict` (DAWG) file, a `.white` (whitelist, text) file, or
     * both.
     * @param {string} name name of the dictionary to load. This can
     * be a be a full path to a .dict file, or it can be a simple
     * dictionary name, in which case the dictionary will be loaded from
     * `Platform.getFilePath("dictionaries")`.
     * @return {Promise} Promise that resolves to a new {@linkcode Dictionary}
     * or undefined if a dictionary of that name could not be loaded.
     */
    static load(name) {
      let path = Platform.parsePath(name);
      //console.log(name,"=>",path);
      if (path.root === "" && path.dir === "" && path.ext === "") {
        // Simple name, load from the dictionaries path. /ignore is a
        // placeholder
        path = Platform.parsePath(Platform.getFilePath("dictionaries/ignore"));
        path.name = name;
        path.ext = ".dict";
      } else if (path.ext === "") {
        // root and/or dir, but no ext
        path.ext = ".dict";
      } else
        name = path.name;
      // Get rid of path.base so Platform.formatPath uses name and ext
      delete path.base;

      if (Dictionary.cache[name])
        return Promise.resolve(Dictionary.cache[name]);

      let dict;
      const zp = Platform.formatPath(path);
      //console.log(zp,"<=",path);
      return Platform.readZip(zp)
      .then(buffer => {
        dict = new Dictionary(name);
        dict.loadDAWG(buffer.buffer);
      })
      .catch(e => {
        // Mostly harmless, .dict load failed, relying on .white
        console.error("Failed to read", zp, e);
      })
      .then(() => {
        path.ext = ".white";
        const wp = Platform.formatPath(path);
        return Platform.readFile(wp)
        .then(text => {
          if (!dict)
            dict = new Dictionary(name);
          const words = text
                .toString()
                .toUpperCase()
                .split(/\r?\n/)
                .map(w => w.replace(/\s.*$/, ""))
                .filter(line => line.length > 0)
                .sort();
          let added = 0;
          words.forEach(w => {
            if (dict._addWord(w))
              added++;
            return false;
          });
          //console.debug("Added", added, "whitelisted words");
        })
        .catch(e => {
          // Mostly harmless, whitelist load failed, relying on .dict
          //console.debug("Failed to read", wp, e);
        });
      })
      .then(() => {
        if (dict) {
          // one of .dict or .white (or both) loaded
          // Add bidirectional traversal links
          dict.addLinks();
          Dictionary.cache[name] = dict;
          //console.debug(`Loaded dictionary ${name}`);
        }
        return dict;
      });
    }
  }

  return Dictionary;
});

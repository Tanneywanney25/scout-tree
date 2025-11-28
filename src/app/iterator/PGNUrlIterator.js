// src/app/iterator/PGNUrlIterator.js

import BaseUrlIterator from './BaseUrlIterator'

export default class PGNUrlIterator extends BaseUrlIterator {
  constructor(url, options = {}) {
    super(url, options)
    this.url = url
  }

  // Inherits iterate() from BaseUrlIterator
  // Just provides a specific implementation for custom PGN URLs
}

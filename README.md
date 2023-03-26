# log-fetch

example of how a url looks like using log-fetch
`hyper://someKeyAsHostname/some/path`

`_` - the drive owned by the user
`Key` - a public key of a drive

method: `HEAD` - does not return a body, only returns headers<br>
hostname:

- `_` - user's drive<br>
  path:
  - `/path/to/dir/or/file` - it can be any path including `/`
    headers:
    - `X-Copy` - `true` | `false` - if true, a directory will be created with the name being the key of the drive, the data will be stored inside that directory. if false, the data will be stored using the path but without the new directory.<br>
    - `X-Timer` - `String` - a number for a timeout<br>
- `Key` - key of a drive
  path:
  - `/path/to/dir/or/file` - it can be any path including `/`
    headers:
    - `X-Copy` - `true` | `false` - if true, a directory will be created with the name being the key of the drive, the data will be stored inside that directory. if false, the data will be stored using the path but without the new directory.<br>
    - `X-Timer` - `String` - a number for a timeout<br>

method: `GET` - return a body<br>
hostname:

- `_` - user's drive<br>
  path:
  - `/path/to/dir/or/file` - it can be any path including `/`
    headers:
    - `X-Timer` - `String` - a number for a timeout<br>
- `Key` - key of a drive
  path:
  - `/path/to/dir/or/file` - it can be any path including `/`
    headers:
    - `X-Timer` - `String` - a number for a timeout<br>

method: `POST` - return a body<br>
hostname:

- `_` - user's drive<br>
  path:
  - `/path/to/dir/or/file` - it can be any path including `/`<br>
    headers:
    - `X-Opt` - `String` - options to use for the content, stringified object<br>

method: `DELETE` - returns a body<br>
hostname:

- `_` - user's drive<br>
  path:
  - `/path/to/dir/or/file` - it can be any path including `/`<br>
    headers:
    - `X-Opt` - `String` - options to use for the content, stringified object<br>

// src/app/Constants.js

// FEN positions
export const ROOT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
export const RACING_KINGS_ROOT_FEN = '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1'

// Time controls
export const TIME_CONTROL_ULTRA_BULLET = "ultraBullet"
export const TIME_CONTROL_BULLET = "bullet"
export const TIME_CONTROL_BLITZ = "blitz"
export const TIME_CONTROL_RAPID = "rapid"
export const TIME_CONTROL_CLASSICAL = "classical"
export const TIME_CONTROL_CORRESPONDENCE = "correspondence"
export const TIME_CONTROL_DAILY = "daily"

// Filter names
export const FILTER_NAME_RATED = "rated"
export const FILTER_NAME_DOWNLOAD_LIMIT = "downloadLimit"
export const FILTER_NAME_OPPONENT = "opponent"
export const FILTER_NAME_ELO_RANGE = "eloRange"
export const FILTER_NAME_FROM_DATE = "fromDate"
export const FILTER_NAME_TO_DATE = "toDate"

// Sites
export const SITE_LICHESS = "lichess"
export const SITE_CHESS_DOT_COM = "chesscom"
export const SITE_PGN_FILE = "pgnfile"
export const SITE_EVENT_DB = "eventdb"
export const SITE_PLAYER_DB = "playerdb"
export const SITE_OPENING_TREE_FILE = "opntfile"
export const SITE_ONLINE_TOURNAMENTS = "tournament"
export const SITE_CUSTOM = 'custom'

// Limits
export const MAX_DOWNLOAD_LIMIT = 2000
export const MAX_ELO_RATING = 3000
export const MAX_GAMES = 100000
export const BATCH_SIZE = 100

// Player colors
export const PLAYER_COLOR_WHITE = 'white'
export const PLAYER_COLOR_BLACK = 'black'

// Chess variants
export const VARIANT_STANDARD = "standard"
export const VARIANT_RACING_KINGS = "racingkings"
export const VARIANT_THREE_CHECK = "threecheck"
export const VARIANT_KING_OF_THE_HILL = "kingofthehill"
export const VARIANT_CRAZYHOUSE = "crazyhouse"

// Chess.com variant rules
export const CHESS_COM_RULES_STANDARD = "chess"
export const CHESS_COM_RULES_THREE_CHECK = "threeCheck"
export const CHESS_COM_RULES_KING_OF_THE_HILL = "kingofthehill"
export const CHESS_COM_RULES_CRAZYHOUSE = "crazyhouse"

// Lichess performance types
export const LICHESS_PERF_RACING_KINGS = "racingKings"
export const LICHESS_PERF_THREE_CHECK = "threeCheck"
export const LICHESS_PERF_KING_OF_THE_HILL = "kingOfTheHill"
export const LICHESS_PERF_CRAZYHOUSE = "crazyhouse"
export const LICHESS_PERF_STANDARD = "standard"

// Lichess variant headers
export const LICHESS_HEADER_RACING_KINGS = "Racing Kings"
export const LICHESS_HEADER_THREE_CHECK = "Three-check"
export const LICHESS_HEADER_KING_OF_THE_HILL = "King of the Hill"
export const LICHESS_HEADER_STANDARD = "Standard"
export const LICHESS_HEADER_CRAZYHOUSE = "Crazyhouse"

// Results
export const RESULT_WHITE_WIN = '1-0'
export const RESULT_BLACK_WIN = '0-1'
export const RESULT_DRAW = '1/2-1/2'

// API endpoints
export const LICHESS_API = 'https://lichess.org'
export const CHESSCOM_API = 'https://api.chess.com/pub'
export const LICHESS_HOST = 'https://lichess.org'
export const LICHESS_CLIENT_ID = 'openingtree.com'

// Opening book types
export const OPENING_BOOK_TYPE_OFF = 'off'
export const OPENING_BOOK_TYPE_MASTERS = 'master'
export const OPENING_BOOK_TYPE_LICHESS = 'lichess'

// Miscellaneous
export const MILLISECS_IN_DAY = 1000 * 60 * 60 * 24
export const LOADER_ANIMATION_DURATION_MS = 500

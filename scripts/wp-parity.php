<?php
/**
 * Runs the WordPress plugin's own credential and Person builders on
 * tests/fixtures/wp-parity/input.json and writes wp-output.json beside it.
 * tests/wp-parity.test.ts compares that with this plugin's output.
 *
 *   php scripts/wp-parity.php <path to a Monprez Schema Identity checkout>
 *
 * Development only. Stubs the four WordPress functions those builders use;
 * nothing else of WordPress is loaded.
 */

$wp = $argv[1] ?? '';
if ( ! is_file( "$wp/includes/class-schema-output.php" ) ) {
	fwrite( STDERR, "usage: php scripts/wp-parity.php <path to a Monprez Schema Identity checkout>\n" );
	exit( 1 );
}
$fixtures = __DIR__ . '/../tests/fixtures/wp-parity';
$input = json_decode( file_get_contents( "$fixtures/input.json" ), true );

define( 'ABSPATH', '/' );
function apply_filters( $hook, $value ) { return $value; }
function current_time( $format ) { global $input; return $input['today']; }
function home_url( $path = '' ) { return 'https://example.com' . $path; }

require "$wp/includes/class-schema-identity.php";
require "$wp/includes/class-schema-output.php";

$person = $input['person'] + [ 'credentials' => $input['rows'] ];
$output = [
	'source'        => 'Monprez Schema Identity ' . ( preg_match( '/^ \* Version: *(\S+)/m', (string) file_get_contents( "$wp/monprez-schema-identity.php" ), $m ) ? $m[1] : 'unknown' ),
	'credential'    => Schema_Identity_Output::build_credentials( $input['rows'] ),
	'certification' => Schema_Identity_Output::build_credentials( $input['rows'], [ 'format' => 'certification' ] ),
	'person'        => Schema_Identity_Output::build_person_node( $person ),
];
file_put_contents( "$fixtures/wp-output.json", json_encode( $output, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . "\n" );
echo "wrote wp-output.json from {$output['source']}\n";
